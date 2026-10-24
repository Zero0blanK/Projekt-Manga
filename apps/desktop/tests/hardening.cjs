const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const connection = require('../dist/main/db/connection.js');
const authCache = require('../dist/main/auth-cache.js');
const { runMigrations } = require('../dist/main/db/migrate.js');
const { sessionCookieOrigins } = require('../dist/main/session-cookie-origins.js');

const WEB_URL = 'http://localhost:3000';

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

/** Loads dist/main/ipc.js against a stub Electron and a recording local store. */
function loadIpc() {
  const handlers = new Map();
  const calls = [];
  const record =
    (name, result) =>
    (...args) => {
      calls.push({ name, args });
      return result;
    };
  const localStore = {
    getMangaDetails: record('getMangaDetails', null),
    syncMangaFromServer: record('syncMangaFromServer', true),
    setMangaInLibrary: record('setMangaInLibrary'),
    markChapterRead: record('markChapterRead'),
    updateChapterProgress: record('updateChapterProgress'),
  };
  const electron = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    shell: {},
    clipboard: { writeText: record('writeText') },
    BrowserWindow: { fromWebContents: (webContents) => ({ webContents }) },
    session: { defaultSession: { cookies: { get: async () => [] } } },
  };
  const stubs = {
    electron,
    './db/local-store': { localStore },
    './auth-cache': { getCachedSession: () => null },
    './sync': {},
    './diagnostics': {},
    './init-state': {},
    './updater': {},
    './startup-background': {},
    './local-archives': { registerLocalArchiveHandlers() {} },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename.endsWith(path.join('main', 'ipc.js')) && request in stubs) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const ipcPath = require.resolve('../dist/main/ipc.js');
  delete require.cache[ipcPath];
  try {
    require(ipcPath).registerIpcHandlers();
  } finally {
    Module._load = originalLoad;
    delete require.cache[ipcPath];
  }
  const frame = {};
  const appEvent = { senderFrame: frame, sender: { mainFrame: frame, getURL: () => WEB_URL } };
  const subframe = { ...appEvent, senderFrame: {} };
  const foreignEvent = {
    senderFrame: frame,
    sender: { mainFrame: frame, getURL: () => 'https://example.test/' },
  };
  const invoke = (event, domain, op, args) =>
    handlers.get('desktop:data:invoke')(event, domain, op, args);
  return { handlers, calls, appEvent, subframe, foreignEvent, invoke };
}

test('data IPC rejects invalid ids and progress values before reaching the store', async () => {
  const { calls, appEvent, invoke } = loadIpc();

  for (const lastPageRead of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
    const result = await invoke(appEvent, 'chapter', 'updateProgress', {
      chapterId: 'chapter-1',
      lastPageRead,
    });
    assert.equal(result.success, false, `lastPageRead ${String(lastPageRead)}`);
  }
  for (const [domain, op, args] of [
    ['chapter', 'updateProgress', { chapterId: '', lastPageRead: 1 }],
    ['chapter', 'markRead', { chapterId: '', isRead: true }],
    ['manga', 'getDetails', { mangaId: '' }],
    ['manga', 'syncOne', { mangaId: '' }],
    ['manga', 'setInLibrary', { mangaId: '', inLibrary: true }],
  ]) {
    const result = await invoke(appEvent, domain, op, args);
    assert.equal(result.success, false, `${domain}.${op} with an empty id`);
  }
  assert.deepEqual(calls, []);

  const valid = await invoke(appEvent, 'chapter', 'updateProgress', {
    chapterId: 'chapter-1',
    lastPageRead: 0,
  });
  assert.deepEqual(valid, { success: true, message: 'OK', data: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'updateChapterProgress');
});

test('syncOne is an explicit library add while other catalog writes are not', async () => {
  const { calls, appEvent, invoke } = loadIpc();
  await invoke(appEvent, 'manga', 'syncOne', { mangaId: 'manga-1' });
  assert.equal(calls[0].name, 'syncMangaFromServer');
  assert.equal(calls[0].args[1], 'manga-1');
  assert.equal(calls[0].args[3], 'add');
});

test('every IPC channel refuses callers outside the app main frame', async () => {
  const { handlers, calls, appEvent, subframe, foreignEvent, invoke } = loadIpc();

  assert.ok(handlers.size > 10);
  for (const [channel, handler] of handlers) {
    if (channel === 'desktop:data:invoke') continue;
    for (const event of [subframe, foreignEvent]) {
      await assert.rejects(
        Promise.resolve().then(() => handler(event, 'text')),
        /only from the app window/,
        channel,
      );
    }
  }
  // The data channel keeps its envelope shape instead of throwing.
  for (const event of [subframe, foreignEvent]) {
    const result = await invoke(event, 'manga', 'getDetails', { mangaId: 'manga-1' });
    assert.equal(result.success, false);
    assert.match(result.message, /only from the app window/);
  }
  assert.deepEqual(calls, []);

  // And the same handlers do run for the real main frame.
  await handlers.get('desktop:clipboard:write')(appEvent, 'copied');
  assert.equal(calls[0].name, 'writeText');
});

test('session cookie origins put the page first and drop the API for .localhost pages', () => {
  assert.deepEqual(sessionCookieOrigins('https://api.example.test/api', 'http://localhost:3000'), [
    'http://localhost:3000',
    'https://api.example.test',
  ]);
  assert.deepEqual(sessionCookieOrigins('http://localhost:4000/api', 'http://localhost:4000'), [
    'http://localhost:4000',
  ]);
  assert.deepEqual(
    sessionCookieOrigins('http://api.localhost:4000/api', 'http://app.localhost:3000'),
    ['http://app.localhost:3000'],
  );
  assert.deepEqual(sessionCookieOrigins('https://api.example.test/api'), [
    'https://api.example.test',
  ]);
});

test('a catalog refresh does not resurrect a removed title or bump its state timestamp', async () => {
  await withStore((store, db) => {
    const manga = { id: 'manga-1', slug: 'slug-1', title: 'A title', source: 'source-a' };
    const state = () =>
      db
        .prepare('SELECT in_library, updated_at FROM manga_state WHERE manga_id = ?')
        .get('manga-1');

    store.upsertManga(manga);
    assert.equal(state().in_library, 1, 'a never-seen title starts in the library');

    store.setMangaInLibrary('manga-1', false);
    db.prepare('UPDATE manga_state SET updated_at = ? WHERE manga_id = ?').run(
      '2026-01-01T00:00:00.000Z',
      'manga-1',
    );

    store.upsertManga({ ...manga, title: 'Refreshed' });
    assert.equal(state().in_library, 0);
    assert.equal(state().updated_at, '2026-01-01T00:00:00.000Z');
    assert.equal(db.prepare('SELECT title FROM manga').get().title, 'Refreshed');

    store.upsertManga(manga, 'add');
    assert.equal(state().in_library, 1);
    assert.notEqual(state().updated_at, '2026-01-01T00:00:00.000Z');

    // Adding a title that is already in the library is not a new change to push.
    db.prepare('UPDATE manga_state SET updated_at = ? WHERE manga_id = ?').run(
      '2026-01-01T00:00:00.000Z',
      'manga-1',
    );
    store.upsertManga(manga, 'add');
    assert.equal(state().updated_at, '2026-01-01T00:00:00.000Z');
  });
});

function pullFixture(overrides = {}) {
  return {
    server_time: '2026-03-01T00:00:00.000Z',
    library: [],
    manga_state: [],
    chapter_state: [],
    manga_category: [],
    history: [],
    categories: [],
    ...overrides,
  };
}

test('pulled changes do not overwrite newer local rows', async () => {
  await withStore((store, db) => {
    store.upsertManga({ id: 'manga-1', slug: 'slug-1', title: 'A', source: 'source-a' });
    store.upsertChapter({ id: 'chapter-1', manga_id: 'manga-1', chapter_number: 1 });
    db.prepare('UPDATE manga_state SET in_library = 1, updated_at = ?').run(
      '2026-02-01T00:00:00.000Z',
    );
    db.prepare('UPDATE chapter_state SET last_page_read = 9, updated_at = ?').run(
      '2026-02-01T00:00:00.000Z',
    );

    store.applyPulledChanges(
      pullFixture({
        library: [
          {
            manga_id: 'manga-1',
            deleted_at: '2026-01-15T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
            edited_at: '2026-01-15T00:00:00.000Z',
          },
        ],
        manga_state: [
          {
            manga_id: 'manga-1',
            is_bookmarked: true,
            shelf_status: null,
            notification_read: false,
            updated_at: '2026-03-01T00:00:00.000Z',
            edited_at: '2026-01-15T00:00:00.000Z',
          },
        ],
        chapter_state: [
          {
            chapter_id: 'chapter-1',
            is_read: false,
            is_bookmark: false,
            last_page_read: 2,
            updated_at: '2026-01-15T00:00:00.000Z',
          },
        ],
      }),
    );
    const manga = db.prepare('SELECT * FROM manga_state').get();
    assert.equal(manga.in_library, 1);
    assert.equal(manga.is_bookmarked, 0);
    assert.equal(db.prepare('SELECT last_page_read FROM chapter_state').get().last_page_read, 9);

    // An older local row still takes the pulled value, for both manga_state domains at once.
    store.applyPulledChanges(
      pullFixture({
        library: [
          {
            manga_id: 'manga-1',
            deleted_at: '2026-04-01T00:00:00.000Z',
            updated_at: '2026-04-02T00:00:00.000Z',
            edited_at: '2026-04-01T00:00:00.000Z',
          },
        ],
        manga_state: [
          {
            manga_id: 'manga-1',
            is_bookmarked: true,
            shelf_status: null,
            notification_read: false,
            updated_at: '2026-04-02T00:00:00.000Z',
            edited_at: '2026-04-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const updated = db.prepare('SELECT * FROM manga_state').get();
    assert.equal(updated.in_library, 0);
    assert.equal(updated.is_bookmarked, 1);
  });
});

test('pulled changes apply atomically', async () => {
  await withStore((store, db) => {
    store.upsertManga({ id: 'manga-1', slug: 'slug-1', title: 'A', source: 'source-a' });
    db.prepare('UPDATE manga_state SET updated_at = ?').run('2026-01-01T00:00:00.000Z');

    assert.throws(() =>
      store.applyPulledChanges(
        pullFixture({
          manga_state: [
            {
              manga_id: 'manga-1',
              is_bookmarked: true,
              shelf_status: null,
              notification_read: false,
              updated_at: '2026-03-01T00:00:00.000Z',
            },
          ],
          // source is NOT NULL: this row fails after the manga_state row above applied.
          history: [
            {
              id: 'history-1',
              source: null,
              manga_id: null,
              manga_slug: 'slug-1',
              title: null,
              thumbnail_url: null,
              chapter_id: null,
              read_at: '2026-03-01T00:00:00.000Z',
              last_read: '2026-03-01T00:00:00.000Z',
              pages_read: 1,
              time_read: 0,
              deleted_at: null,
            },
          ],
        }),
      ),
    );
    assert.equal(db.prepare('SELECT is_bookmarked FROM manga_state').get().is_bookmarked, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 0);
    // The connection is usable afterwards: the failed transaction was rolled back.
    assert.doesNotThrow(() => store.applyPulledChanges(pullFixture()));
  });
});

test('a database from a newer schema is refused without being changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-downgrade-'));
  const file = path.join(dir, 'newer.db');
  try {
    let db = new DatabaseSync(file);
    runMigrations(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      999,
      'from_the_future',
      '2099-01-01',
    );
    db.close();

    db = new DatabaseSync(file);
    try {
      const before = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.throws(() => runMigrations(db), /newer version of Projekt Manga/);
      assert.deepEqual(
        db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
        before,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rebuild migration that leaves a dangling reference rolls back instead of committing', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'initial_local_schema', '2026-01-01');
      INSERT INTO schema_migrations VALUES (2, 'chapter_manga_id_nullable', '2026-01-01');
      INSERT INTO schema_migrations VALUES (3, 'history_source_manga_id', '2026-01-01');
      CREATE TABLE manga (
        id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, author TEXT,
        source TEXT, thumbnail_url TEXT, artist TEXT, description TEXT, genres TEXT,
        status TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE chapter (id TEXT PRIMARY KEY, manga_id TEXT REFERENCES manga(id));
    `);
    // A child row pointing at a manga that does not exist: the version 4 rebuild runs with
    // enforcement off, so only the pre-commit check can catch it.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("INSERT INTO chapter (id, manga_id) VALUES ('orphan', 'missing')");
    db.exec('PRAGMA foreign_keys = ON');

    assert.throws(() => runMigrations(db), /foreign key violation/);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 4').get().n,
      0,
    );
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'manga_new'").get() === undefined,
    );
  } finally {
    db.close();
  }
});
