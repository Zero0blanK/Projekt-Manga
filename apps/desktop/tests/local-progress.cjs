const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const connection = require('../dist/main/db/connection.js');
const authCache = require('../dist/main/auth-cache.js');
const { runMigrations } = require('../dist/main/db/migrate.js');

/** A chapter of source-a/slug-1 as the server sends it: row id plus the source's key. */
const serverChapter = (id, chapter_number, extra = {}) => ({
  id,
  source: 'source-a',
  manga_slug: 'slug-1',
  source_chapter_key: id,
  manga_id: 'manga-1',
  chapter_number,
  ...extra,
});

/** How the renderer names a chapter of source-a/slug-1. */
const ref = (key, extra = {}) => ({
  source: 'source-a',
  manga_slug: 'slug-1',
  source_chapter_key: key,
  ...extra,
});

async function withStore(run) {
  const db = new DatabaseSync(':memory:');
  const originalGetDb = connection.getDb;
  const originalGetCachedSession = authCache.getCachedSession;
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    connection.getDb = () => db;
    authCache.getCachedSession = () => null;
    const { localStore } = require('../dist/main/db/local-store.js');
    return await run(localStore, db);
  } finally {
    connection.getDb = originalGetDb;
    authCache.getCachedSession = originalGetCachedSession;
    db.close();
  }
}

test('desktop progress fills a missing chapter total and marking unread clears the saved page', async () => {
  await withStore((store) => {
    store.upsertManga({
      id: 'manga-1',
      slug: 'slug-1',
      title: 'A title',
      source: 'source-a',
    });
    store.upsertChapter(serverChapter('chapter-3', 3));

    store.updateChapterProgress(ref('chapter-3', { page_count: 10 }), 7);
    assert.equal(store.getMangaDetails('manga-1').chapters[0].last_page_read, 7);
    assert.equal(store.getMangaDetails('manga-1').chapters[0].page_count, 10);

    store.markChapterRead(ref('chapter-3'), false);
    assert.equal(store.getMangaDetails('manga-1').chapters[0].last_page_read, 0);
  });
});

test('syncing an added title links source-only reading history in the desktop cache', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async (store, db) => {
      // Read from the source before the title was added: a local row under a local id.
      db.prepare(
        `INSERT INTO chapter (id, source, manga_slug, source_chapter_key, chapter_number, updated_at)
         VALUES (?, 'source-a', 'slug-1', 'chapter-3', 0, ?)`,
      ).run('local-3', new Date().toISOString());
      db.prepare(
        `INSERT INTO history (id, source, manga_slug, chapter_id, read_at, last_read)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('history-1', 'source-a', 'slug-1', 'local-3', '2026-01-01', '2026-01-01');
      db.prepare(
        `INSERT INTO chapter_state (chapter_id, is_read, last_page_read, updated_at)
         VALUES ('local-3', 0, 4, '2026-01-01')`,
      ).run();
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'manga-1',
              slug: 'slug-1',
              title: 'A title',
              source: 'source-a',
              chapters: [serverChapter('server-row-3', 3, { source_chapter_key: 'chapter-3' })],
            },
          }),
        );

      assert.equal(
        await store.syncMangaFromServer('http://127.0.0.1:4000/api', 'manga-1', null),
        true,
      );
      // The local row was the same chapter: it takes the server's id, keeping its
      // progress and history, instead of sitting beside it as a duplicate.
      const chapters = store.getMangaDetails('manga-1').chapters;
      assert.deepEqual(
        chapters.map((c) => [c.id, c.source_chapter_key, c.last_page_read]),
        [['server-row-3', 'chapter-3', 4]],
      );
      assert.equal(store.listHistory()[0].chapter_id, 'server-row-3');
      assert.equal(store.listHistory()[0].source_chapter_key, 'chapter-3');
      assert.equal(store.listHistory()[0].manga_id, 'manga-1');
      assert.equal(store.listHistory()[0].in_library, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('merge reconciliation keeps local progress while replace discards it', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async (store) => {
      store.upsertManga({ id: 'manga-1', slug: 'slug-1', title: 'Local', source: 'source-a' });
      store.upsertChapter(serverChapter('chapter-1', 1));
      store.updateChapterProgress(ref('chapter-1'), 8);
      const details = {
        id: 'manga-1',
        slug: 'slug-1',
        title: 'Server',
        source: 'source-a',
        chapters: [serverChapter('chapter-1', 1, { last_page_read: 2 })],
      };
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        const data = path.endsWith('/manga/details/manga-1')
          ? details
          : path.endsWith('/manga')
            ? [{ id: 'manga-1' }]
            : [];
        return new Response(JSON.stringify({ success: true, data }), {
          headers: { 'Content-Type': 'application/json' },
        });
      };

      await store.reconcileRestoreFromServer('http://127.0.0.1:4000/api', 'merge');
      assert.equal(store.getMangaDetails('manga-1').chapters[0].last_page_read, 8);
      await store.reconcileRestoreFromServer('http://127.0.0.1:4000/api', 'replace');
      assert.equal(store.getMangaDetails('manga-1').chapters[0].last_page_read, 2);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a replace restore keeps reading done while it ran, and sends it next', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async (store) => {
      store.upsertManga({ id: 'manga-1', slug: 'slug-1', title: 'Local', source: 'source-a' });
      store.upsertChapter(serverChapter('chapter-1', 1));
      store.upsertChapter(serverChapter('chapter-2', 2));
      // Before the restore: replaced by it, as a replace should.
      store.updateChapterProgress(ref('chapter-1'), 8);
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // While it ran: the reader kept going.
      store.updateChapterProgress(ref('chapter-2'), 6);
      store.addHistory({
        source: 'source-a',
        manga_slug: 'slug-1',
        manga_id: 'manga-1',
        title: 'Local',
        source_chapter_key: 'chapter-2',
        pages_read: 6,
        time_read: 30,
      });
      const details = {
        id: 'manga-1',
        slug: 'slug-1',
        title: 'Server',
        source: 'source-a',
        chapters: [
          serverChapter('chapter-1', 1, { last_page_read: 2 }),
          serverChapter('chapter-2', 2, { last_page_read: 0 }),
        ],
      };
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        const data = path.endsWith('/manga/details/manga-1')
          ? details
          : path.endsWith('/manga')
            ? [{ id: 'manga-1' }]
            : [];
        return new Response(JSON.stringify({ success: true, data }), {
          headers: { 'Content-Type': 'application/json' },
        });
      };

      await store.reconcileRestoreFromServer(
        'http://127.0.0.1:4000/api',
        'replace',
        new Date(startedAt).toISOString(),
      );

      const chapters = store.getMangaDetails('manga-1').chapters;
      assert.equal(chapters.find((c) => c.id === 'chapter-1').last_page_read, 2);
      assert.equal(chapters.find((c) => c.id === 'chapter-2').last_page_read, 6);
      // And it waits to be sent, rather than counting as already pushed.
      const pending = store.getPendingChanges();
      assert.deepEqual(
        pending.chapter_state.map((row) => [row.source_chapter_key, row.last_page_read]),
        [['chapter-2', 6]],
      );
      assert.equal(pending.history.length, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a stale desktop generation reconciles before it can push offline progress', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async (store, db) => {
      authCache.getCachedSession = () => ({
        user_id: 'account-1',
        email: 'reader@example.com',
        device_id: 'device-1',
        session_id: 'session-1',
        cached_at: new Date().toISOString(),
      });
      store.upsertManga({ id: 'manga-1', slug: 'slug-1', title: 'Old', source: 'source-a' });
      store.upsertChapter(serverChapter('chapter-1', 1));
      store.updateChapterProgress(ref('chapter-1'), 8);
      store.setSyncGeneration(0);
      let pushed = false;
      globalThis.fetch = async (url, init) => {
        if (init?.method === 'POST') pushed = true;
        const path = new URL(url).pathname;
        const data = path.endsWith('/sync/generation')
          ? { generation: 1 }
          : path.endsWith('/sync/pull')
            ? {
                generation: 1,
                server_time: new Date().toISOString(),
                has_more: false,
                library: [],
                manga_state: [],
                chapter_state: [],
                manga_category: [],
                history: [],
                categories: [],
              }
            : [];
        return new Response(JSON.stringify({ success: true, data }), {
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const { runSync } = require('../dist/main/sync.js');
      await runSync('http://127.0.0.1:4000/api');
      assert.equal(pushed, false);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chapter_state').get().count, 0);
      assert.equal(store.getSyncGeneration(), 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sync shares one in-flight run across windows and aborts on logout', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async () => {
      authCache.getCachedSession = () => ({
        user_id: 'account-1',
        email: 'reader@example.com',
        device_id: 'device-1',
        session_id: 'session-1',
        cached_at: new Date().toISOString(),
      });
      let requestSignal;
      globalThis.fetch = async (_url, init) => {
        requestSignal = init.signal;
        return new Promise((_resolve, reject) => {
          requestSignal.addEventListener('abort', () => reject(requestSignal.reason), {
            once: true,
          });
        });
      };

      const { cancelActiveSync, runSync } = require('../dist/main/sync.js');
      const first = runSync('http://127.0.0.1:4000/api');
      const duplicate = runSync('http://127.0.0.1:4000/api');
      assert.equal(duplicate, first);
      await new Promise(setImmediate);
      assert.ok(requestSignal);

      cancelActiveSync();
      await assert.rejects(first, /abort|cancel/i);
      assert.equal(requestSignal.aborted, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an interrupted or partially rejected push is retried without advancing its cursor', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async (store) => {
      authCache.getCachedSession = () => ({
        user_id: 'account-1',
        email: 'reader@example.com',
        device_id: 'device-1',
        session_id: 'session-1',
        cached_at: new Date().toISOString(),
      });
      store.upsertManga({ id: 'manga-1', slug: 'slug-1', title: 'A title', source: 'source-a' });
      store.upsertChapter(serverChapter('chapter-1', 1));
      store.updateChapterProgress(ref('chapter-1'), 6);
      store.setSyncGeneration(0);

      let failure = 'network';
      const pushBodies = [];
      const requests = [];
      globalThis.fetch = async (url, init) => {
        const path = new URL(url).pathname;
        requests.push(path);
        if (path.endsWith('/sync/generation')) {
          return new Response(JSON.stringify({ success: true, data: { generation: 0 } }));
        }
        if (path.endsWith('/sync/push')) {
          pushBodies.push(JSON.parse(init.body));
          if (failure === 'network') throw new Error('fixture connection interrupted');
          const failed = failure === 'partial' ? ['chapter-1'] : [];
          const data = Object.fromEntries(
            ['library', 'manga_state', 'chapter_state', 'manga_category', 'history'].map(
              (domain) => [
                domain,
                { applied: 0, failed: domain === 'chapter_state' ? failed : [] },
              ],
            ),
          );
          return new Response(JSON.stringify({ success: true, data }));
        }
        if (path.endsWith('/sync/pull')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                server_time: new Date().toISOString(),
                has_more: false,
                library: [],
                manga_state: [],
                chapter_state: [],
                manga_category: [],
                history: [],
                categories: [],
              },
            }),
          );
        }
        throw new Error(`Unexpected sync request ${path}`);
      };

      const { runSync } = require('../dist/main/sync.js');
      await assert.rejects(runSync('http://127.0.0.1:4000/api'), /interrupted/);
      assert.equal(store.getSyncCursor().last_pushed_at, null);
      assert.equal(
        requests.some((path) => path.endsWith('/sync/pull')),
        false,
      );

      failure = 'partial';
      await runSync('http://127.0.0.1:4000/api');
      assert.equal(store.getSyncCursor().last_pushed_at, null);
      assert.equal(
        requests.some((path) => path.endsWith('/sync/pull')),
        false,
      );

      failure = 'none';
      await runSync('http://127.0.0.1:4000/api');
      assert.ok(store.getSyncCursor().last_pushed_at);
      assert.equal(pushBodies.length, 3);
      for (const body of pushBodies) {
        assert.equal(body.chapter_state.length, 1);
        assert.deepEqual(
          [
            body.chapter_state[0].source,
            body.chapter_state[0].manga_slug,
            body.chapter_state[0].source_chapter_key,
          ],
          ['source-a', 'slug-1', 'chapter-1'],
        );
        assert.equal(body.chapter_state[0].chapter_id, undefined);
        assert.equal(body.chapter_state[0].last_page_read, 6);
      }
      assert.equal(
        requests.some((path) => path.endsWith('/sync/pull')),
        true,
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a chapter the server relinked arrives as a new key on the same row', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async (store, db) => {
      store.upsertManga({ id: 'manga-1', slug: 'slug-1', title: 'A title', source: 'source-a' });
      store.upsertChapter(serverChapter('row-5', 5, { source_chapter_key: 'old-5' }));
      store.upsertChapter(serverChapter('gone-6', 6));
      store.upsertChapter(serverChapter('kept-7', 7));
      // Not yet pushed: the server never saw this progress.
      store.updateChapterProgress(ref('old-5'), 9);
      store.updateChapterProgress(ref('kept-7'), 2);
      db.prepare(
        `INSERT INTO history (id, source, manga_slug, chapter_id, read_at, last_read)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('history-1', 'source-a', 'slug-1', 'row-5', '2026-01-01', '2026-01-01');
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'manga-1',
              slug: 'slug-1',
              title: 'A title',
              source: 'source-a',
              chapters: [serverChapter('row-5', 5, { source_chapter_key: 'new-5' })],
            },
          }),
        );

      assert.equal(
        await store.syncMangaFromServer('http://127.0.0.1:4000/api', 'manga-1', null),
        true,
      );
      const chapters = store.getMangaDetails('manga-1').chapters;
      // gone-6 had nothing hanging off it; kept-7 has unpushed progress.
      assert.deepEqual(chapters.map((c) => c.id).sort(), ['kept-7', 'row-5']);
      const relinked = chapters.find((c) => c.id === 'row-5');
      assert.equal(relinked.source_chapter_key, 'new-5');
      assert.equal(relinked.last_page_read, 9);
      assert.equal(store.listHistory()[0].chapter_id, 'row-5');
      assert.equal(store.listHistory()[0].source_chapter_key, 'new-5');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('folding a local stub into a chapter that has history leaves one live history row', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async (store, db) => {
      store.upsertManga({ id: 'manga-1', slug: 'slug-1', title: 'A title', source: 'source-a' });
      store.upsertChapter(serverChapter('row-5', 5, { source_chapter_key: 'old-5' }));
      // Read here under the source's new key before the relink reached this device.
      db.prepare(
        `INSERT INTO chapter (id, source, manga_slug, source_chapter_key, chapter_number, updated_at)
         VALUES ('stub-5', 'source-a', 'slug-1', 'new-5', 0, ?)`,
      ).run(new Date().toISOString());
      const insertHistory = db.prepare(
        `INSERT INTO history (id, source, manga_slug, chapter_id, read_at, last_read, pages_read, time_read)
         VALUES (?, 'source-a', 'slug-1', ?, ?, ?, ?, ?)`,
      );
      insertHistory.run('history-kept', 'row-5', '2026-01-01', '2026-01-01', 4, 1000);
      insertHistory.run('history-stub', 'stub-5', '2026-02-01', '2026-02-01', 9, 500);
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'manga-1',
              slug: 'slug-1',
              title: 'A title',
              source: 'source-a',
              chapters: [serverChapter('row-5', 5, { source_chapter_key: 'new-5' })],
            },
          }),
        );

      assert.equal(
        await store.syncMangaFromServer('http://127.0.0.1:4000/api', 'manga-1', null),
        true,
      );
      const live = store.listHistory();
      assert.deepEqual(
        live.map((entry) => [entry.id, entry.chapter_id]),
        [['history-kept', 'row-5']],
      );
      const kept = db.prepare(`SELECT * FROM history WHERE id = 'history-kept'`).get();
      assert.equal(kept.last_read, '2026-02-01');
      assert.equal(kept.pages_read, 9);
      assert.equal(kept.time_read, 1500);
      // The stub's row stays as a tombstone, so the next push removes it everywhere.
      const tombstone = db.prepare(`SELECT * FROM history WHERE id = 'history-stub'`).get();
      assert.ok(tombstone.deleted_at);
      assert.equal(tombstone.chapter_id, 'row-5');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the same source key under two titles stays two chapters', async () => {
  await withStore((store) => {
    store.markChapterRead(ref('chapter-1'), true);
    store.markChapterRead(ref('chapter-1', { manga_slug: 'other-title' }), false);
    store.updateChapterProgress(ref('chapter-1', { manga_slug: 'other-title' }), 3);

    const pending = store.getPendingChanges().chapter_state;
    assert.deepEqual(
      pending
        .map((row) => [row.manga_slug, row.source_chapter_key, row.is_read, row.last_page_read])
        .sort(),
      [
        ['other-title', 'chapter-1', false, 3],
        ['slug-1', 'chapter-1', true, 0],
      ],
    );
  });
});

test('a pulled state for a chapter this device never stored stands up a row by its key', async () => {
  await withStore((store) => {
    const result = store.applyPulledChanges({
      server_time: new Date().toISOString(),
      library: [],
      manga_state: [],
      chapter_state: [
        {
          ...ref('chapter-9'),
          is_read: true,
          is_bookmark: false,
          last_page_read: 0,
          updated_at: '2026-02-01T00:00:00.000Z',
        },
      ],
      manga_category: [],
      history: [],
      categories: [],
    });

    assert.equal(result.skippedCount, 0);
    store.markChapterRead(ref('chapter-9'), false);
    assert.equal(store.getPendingChanges().chapter_state[0].source_chapter_key, 'chapter-9');
  });
});
