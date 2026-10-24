const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const connection = require('../dist/main/db/connection.js');
const authCache = require('../dist/main/auth-cache.js');
const { runMigrations } = require('../dist/main/db/migrate.js');

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
    store.upsertChapter({ id: 'chapter-3', manga_id: 'manga-1', chapter_number: 3 });

    store.updateChapterProgress('chapter-3', 7, { page_count: 10 });
    assert.equal(store.getMangaDetails('manga-1').chapters[0].last_page_read, 7);
    assert.equal(store.getMangaDetails('manga-1').chapters[0].page_count, 10);

    store.markChapterRead('chapter-3', false);
    assert.equal(store.getMangaDetails('manga-1').chapters[0].last_page_read, 0);
  });
});

test('syncing an added title links source-only reading history in the desktop cache', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withStore(async (store, db) => {
      db.prepare(`INSERT INTO chapter (id, chapter_number, updated_at) VALUES (?, 0, ?)`).run(
        'chapter-3',
        new Date().toISOString(),
      );
      db.prepare(
        `INSERT INTO history (id, source, manga_slug, chapter_id, read_at, last_read)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('history-1', 'source-a', 'slug-1', 'chapter-3', '2026-01-01', '2026-01-01');
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'manga-1',
              slug: 'slug-1',
              title: 'A title',
              source: 'source-a',
              chapters: [{ id: 'chapter-3', chapter_number: 3, page_count: 10 }],
            },
          }),
        );

      assert.equal(
        await store.syncMangaFromServer('http://127.0.0.1:4000/api', 'manga-1', null),
        true,
      );
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
      store.upsertChapter({ id: 'chapter-1', manga_id: 'manga-1', chapter_number: 1 });
      store.updateChapterProgress('chapter-1', 8);
      const details = {
        id: 'manga-1',
        slug: 'slug-1',
        title: 'Server',
        source: 'source-a',
        chapters: [{ id: 'chapter-1', chapter_number: 1, last_page_read: 2 }],
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
      store.upsertChapter({ id: 'chapter-1', manga_id: 'manga-1', chapter_number: 1 });
      store.updateChapterProgress('chapter-1', 8);
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
      store.upsertChapter({ id: 'chapter-1', manga_id: 'manga-1', chapter_number: 1 });
      store.updateChapterProgress('chapter-1', 6);
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
        assert.equal(body.chapter_state[0].chapter_id, 'chapter-1');
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
