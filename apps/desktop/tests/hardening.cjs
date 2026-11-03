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

/** Loads dist/main/ipc.js against a stub Electron and a recording local store, with
 * `session` as the cached signed-in account (none by default). */
function loadIpc({ session = null } = {}) {
  const handlers = new Map();
  const lock = { locked: false };
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
    BrowserWindow: {
      fromWebContents: (webContents) => ({
        webContents,
        isAlwaysOnTop: () => webContents.alwaysOnTop === true,
        setAlwaysOnTop: (value) => {
          calls.push({ name: 'setAlwaysOnTop', args: [value] });
          webContents.alwaysOnTop = value;
        },
        setProgressBar: (value) => calls.push({ name: 'setProgressBar', args: [value] }),
        setOverlayIcon: (icon, description) =>
          calls.push({ name: 'setOverlayIcon', args: [icon && icon.source, description] }),
      }),
    },
    app: { setBadgeCount: (count) => calls.push({ name: 'setBadgeCount', args: [count] }) },
    nativeImage: {
      createFromDataURL: (url) => ({
        source: url,
        isEmpty: () => !url.endsWith('AAAA'),
        getSize: () =>
          url.includes('huge') ? { width: 512, height: 512 } : { width: 32, height: 32 },
      }),
    },
    session: { defaultSession: { cookies: { get: async () => [] } } },
  };
  const stubs = {
    electron,
    './db/local-store': { localStore },
    './auth-cache': { getCachedSession: () => session },
    './sync': {},
    './diagnostics': {},
    './init-state': {},
    './updater': {},
    './startup-background': {
      setCloseToTray: async (value) => {
        calls.push({ name: 'setCloseToTray', args: [value] });
        return { supported: true, enabled: value };
      },
    },
    './local-archives': { registerLocalArchiveHandlers() {} },
    './app-lock': {
      isAppLocked: () => lock.locked,
      getAppLockState: () => ({ enabled: true, idleMinutes: 0, locked: lock.locked }),
      setAppLock: async () => ({ enabled: true, idleMinutes: 0, locked: false }),
      clearAppLock: async () => ({ enabled: false, idleMinutes: 0, locked: false }),
      lockApp: () => {
        lock.locked = true;
      },
    },
    './desktop-preferences': { getDesktopPreferences: () => ({ hideFromCapture: false }) },
    './window': {
      setHideFromCapture: (value) => {
        calls.push({ name: 'setHideFromCapture', args: [value] });
        return value;
      },
    },
    './source-browser': {
      openSourceBrowser: async (...args) => {
        calls.push({ name: 'openSourceBrowser', args });
        return { saved: true, cookieCount: 1, message: 'Saved' };
      },
    },
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
  return { handlers, calls, appEvent, subframe, foreignEvent, invoke, lock };
}

const CHAPTER = { source: 'source-a', manga_slug: 'slug-1', source_chapter_key: 'chapter-1' };

test('data IPC rejects invalid ids and progress values before reaching the store', async () => {
  const { calls, appEvent, invoke } = loadIpc();

  for (const lastPageRead of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
    const result = await invoke(appEvent, 'chapter', 'updateProgress', {
      chapter: CHAPTER,
      lastPageRead,
    });
    assert.equal(result.success, false, `lastPageRead ${String(lastPageRead)}`);
  }
  for (const [domain, op, args] of [
    [
      'chapter',
      'updateProgress',
      { chapter: { ...CHAPTER, source_chapter_key: '' }, lastPageRead: 1 },
    ],
    ['chapter', 'markRead', { chapter: { ...CHAPTER, source: '' }, isRead: true }],
    ['chapter', 'markRead', { isRead: true }],
    ['chapter', 'markRead', { chapter: { ...CHAPTER, page_count: 'many' }, isRead: true }],
    ['chapter', 'markRead', { chapter: { ...CHAPTER, manga_slug: 'x'.repeat(513) }, isRead: true }],
    ['manga', 'getDetails', { mangaId: '' }],
    ['manga', 'syncOne', { mangaId: '' }],
    ['manga', 'setInLibrary', { mangaId: '', inLibrary: true }],
  ]) {
    const result = await invoke(appEvent, domain, op, args);
    assert.equal(result.success, false, `${domain}.${op} with an empty id`);
  }
  assert.deepEqual(calls, []);

  const valid = await invoke(appEvent, 'chapter', 'updateProgress', {
    chapter: CHAPTER,
    lastPageRead: 0,
  });
  assert.deepEqual(valid, { success: true, message: 'OK', data: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'updateChapterProgress');
});

test('the renderer uses the server library like a browser, signed in or not', async () => {
  // The app and every browser on the same server show one library; a local copy would
  // split them, anonymous or signed in.
  const anonymous = loadIpc();
  assert.deepEqual((await anonymous.invoke(anonymous.appEvent, 'meta', 'mode')).data, {
    localFirst: false,
  });
  const signedIn = loadIpc({ session: { user_id: 'user-1', session_id: 'session-1' } });
  assert.deepEqual((await signedIn.invoke(signedIn.appEvent, 'meta', 'mode')).data, {
    localFirst: false,
  });
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

test('window.setAlwaysOnTop accepts only a boolean, for the calling window', async () => {
  const { handlers, calls, appEvent } = loadIpc();
  const set = handlers.get('desktop:window:set-always-on-top');
  const get = handlers.get('desktop:window:get-always-on-top');
  assert.ok(set && get, 'always-on-top channels are registered');
  for (const value of [undefined, null, 'true', 1, {}, []]) {
    await assert.rejects(
      Promise.resolve().then(() => set(appEvent, value)),
      /must be a boolean/,
      JSON.stringify(value) ?? 'undefined',
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(await set(appEvent, true), { success: true, message: 'OK', data: true });
  assert.deepEqual(await get(appEvent), { success: true, message: 'OK', data: true });
  assert.deepEqual(calls, [{ name: 'setAlwaysOnTop', args: [true] }]);
});

test('window progress and close-to-tray accept only their own value types', async () => {
  const { handlers, calls, appEvent } = loadIpc();
  const progress = handlers.get('desktop:window:set-progress');
  const closeToTray = handlers.get('desktop:close-to-tray:set');
  for (const value of [undefined, 'half', Number.NaN, Number.POSITIVE_INFINITY, {}, [0.5]]) {
    await assert.rejects(
      Promise.resolve().then(() => progress(appEvent, value)),
      /progress must be/,
      String(value),
    );
  }
  for (const value of [undefined, null, 'true', 1]) {
    await assert.rejects(
      Promise.resolve().then(() => closeToTray(appEvent, value)),
      /must be a boolean/,
      String(value),
    );
  }
  assert.deepEqual(calls, []);
  await progress(appEvent, 0.5);
  await progress(appEvent, 7);
  await progress(appEvent, -3);
  await progress(appEvent, null);
  await closeToTray(appEvent, true);
  assert.deepEqual(calls, [
    { name: 'setProgressBar', args: [0.5] },
    { name: 'setProgressBar', args: [1] },
    { name: 'setProgressBar', args: [0] },
    { name: 'setProgressBar', args: [-1] },
    { name: 'setCloseToTray', args: [true] },
  ]);
});

test('while the app is locked every channel refuses, data included', async () => {
  const { handlers, calls, appEvent, invoke, lock } = loadIpc();
  await handlers.get('desktop:lock:now')(appEvent);
  assert.equal(lock.locked, true);
  for (const [channel, handler] of handlers) {
    if (channel === 'desktop:data:invoke') continue;
    await assert.rejects(
      Promise.resolve().then(() => handler(appEvent, true)),
      /locked/,
      channel,
    );
  }
  const result = await invoke(appEvent, 'manga', 'getDetails', { mangaId: 'manga-1' });
  assert.equal(result.success, false);
  assert.deepEqual(calls, []);
  lock.locked = false;
  await assert.rejects(
    Promise.resolve().then(() => handlers.get('desktop:capture:set')(appEvent, 'yes')),
    /must be a boolean/,
  );
  await handlers.get('desktop:capture:set')(appEvent, true);
  assert.deepEqual(calls, [{ name: 'setHideFromCapture', args: [true] }]);
});

test('source.openBrowser validates its argument before opening anything', async () => {
  const { handlers, calls, appEvent } = loadIpc();
  const open = handlers.get('desktop:source:open-browser');
  assert.ok(open, 'source.openBrowser is registered');

  for (const args of [
    undefined,
    null,
    'mangadex',
    ['mangadex'],
    {},
    { sourceId: '' },
    { sourceId: 42 },
    { sourceId: '../../etc' },
    { sourceId: 'a b' },
    { sourceId: 'https://evil.test/' },
    { sourceId: 'x'.repeat(129) },
    { sourceId: '-leading-dash' },
  ]) {
    await assert.rejects(
      Promise.resolve().then(() => open(appEvent, args)),
      /openBrowser expects|sourceId must be/,
      JSON.stringify(args) ?? 'undefined',
    );
  }
  assert.deepEqual(calls, []);

  // Only the id crosses the boundary: a renderer cannot choose the URL or the hosts.
  const result = await open(appEvent, {
    sourceId: 'manga-site.en',
    baseUrl: 'https://evil.test/',
    allowedHosts: ['evil.test'],
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    { name: 'openSourceBrowser', args: ['manga-site.en', { closeWhenPassed: false }] },
  ]);
});

test('source browser policy keeps cookies for allowed hosts only, on a local server only', () => {
  const policy = require('../dist/main/source-browser-policy.js');

  assert.equal(policy.isLoopbackApi('http://127.0.0.1:4123/api'), true);
  assert.equal(policy.isLoopbackApi('http://localhost:4000/api'), true);
  assert.equal(policy.isLoopbackApi('http://[::1]:4000/api'), true);
  assert.equal(policy.isLoopbackApi('https://manga.example.com/api'), false);
  assert.equal(policy.isLoopbackApi('http://192.168.1.20:4000/api'), false);
  assert.equal(policy.isLoopbackApi('not a url'), false);

  assert.equal(
    policy.startUrlFor('https://www.site.example/', ['site.example']),
    'https://www.site.example/',
  );
  assert.throws(() => policy.startUrlFor('https://other.example/', ['site.example']), /not one/);
  assert.throws(() => policy.startUrlFor('file:///etc/passwd', ['site.example']), /no usable/);
  assert.throws(() => policy.startUrlFor('javascript:alert(1)', ['site.example']), /no usable/);

  assert.equal(policy.partitionFor('Manga.Site'), 'persist:source-browser-manga-site');
  assert.notEqual(policy.partitionFor('a'), policy.partitionFor('b'));

  assert.equal(
    policy.browserUserAgent(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) projekt-manga/1.2.3 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
    ),
    'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  );
  // The header lists what navigator.languages lists; Electron adds the weights.
  assert.equal(policy.acceptLanguages(['en-US', 'ja', 'en-US']), 'en-US,ja');
  assert.equal(policy.acceptLanguages(['bad tag;q=1']), 'en-US');

  const identity = policy.browserIdentity(
    'Mozilla/5.0 Chrome/142.0.7444.175 Electron/43.8.0',
    ['en-US', 'ja'],
    '142.0.7444.175',
    'win32',
    'x64',
  );
  assert.equal(identity.platform, 'Win32');
  assert.equal(identity.acceptLanguage, 'en-US,ja');
  assert.equal(
    identity.userAgent,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  );
  assert.equal(identity.userAgentMetadata.platform, 'Windows');
  assert.deepEqual(identity.userAgentMetadata.brands, [
    { brand: 'Chromium', version: '142' },
    { brand: 'Google Chrome', version: '142' },
    { brand: 'Not A(Brand', version: '99' },
  ]);
  assert.deepEqual(identity.userAgentMetadata.fullVersionList, [
    { brand: 'Chromium', version: '142.0.7444.175' },
    { brand: 'Google Chrome', version: '142.0.7444.175' },
    { brand: 'Not A(Brand', version: '99.0.0.0' },
  ]);
  assert.equal(identity.clientHints['sec-ch-ua-mobile'], '?0');
  assert.equal(identity.clientHints['sec-ch-ua-platform'], '"Windows"');
  assert.match(identity.clientHints['sec-ch-ua'], /"Google Chrome";v="142"/);

  const headers = {
    'User-Agent': 'Electron/43.8.0',
    'sec-ch-ua': '"Chromium";v="142"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    Accept: 'text/html',
  };
  policy.applyBrowserIdentityHeaders(headers, identity);
  assert.equal(headers['User-Agent'], identity.userAgent);
  assert.equal(headers['sec-ch-ua'], identity.clientHints['sec-ch-ua']);
  assert.equal(headers.Accept, 'text/html');
  assert.equal(
    Object.keys(headers).filter((name) => name.toLowerCase() === 'user-agent').length,
    1,
  );

  const insecure = {
    'user-agent': 'Electron/43.8.0',
    'sec-ch-ua': '"Chromium";v="142"',
    Accept: 'text/html',
  };
  policy.applyBrowserIdentityHeaders(insecure, identity, false);
  assert.equal(insecure['User-Agent'], identity.userAgent);
  assert.equal(insecure['user-agent'], undefined);
  assert.equal(insecure['sec-ch-ua'], undefined);
  assert.equal(insecure.Accept, 'text/html');

  const kept = policy.cookiesForAllowedHosts(
    [
      {
        name: 'cf_clearance',
        value: 'a',
        domain: '.site.example',
        path: '/',
        secure: true,
        httpOnly: true,
        expirationDate: 2000000000,
      },
      { name: 'login', value: 'b', domain: 'www.site.example', hostOnly: true, session: true },
      { name: 'ads', value: 'c', domain: '.tracker.example' },
      { name: 'tld', value: 'd', domain: '.example' },
      { name: 'huge', value: 'x'.repeat(4097), domain: 'site.example' },
    ],
    ['www.site.example'],
  );
  assert.deepEqual(kept, [
    {
      name: 'cf_clearance',
      value: 'a',
      domain: 'site.example',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      expires: 2000000000,
    },
    {
      name: 'login',
      value: 'b',
      domain: 'www.site.example',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
    },
  ]);
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
    store.upsertChapter({ id: 'chapter-1', ...CHAPTER, manga_id: 'manga-1', chapter_number: 1 });
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
            ...CHAPTER,
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

test('the taskbar badge takes only a whole count and, on Windows, a small PNG', async () => {
  const { handlers, calls, appEvent } = loadIpc();
  const badge = handlers.get('desktop:window:set-badge');
  for (const input of [
    undefined,
    {},
    { count: -1 },
    { count: 1.5 },
    { count: '3' },
    { count: 1e6 },
  ]) {
    await assert.rejects(
      Promise.resolve().then(() => badge(appEvent, input)),
      /badge count must be/,
      JSON.stringify(input) ?? 'undefined',
    );
  }
  assert.deepEqual(calls, []);
  const png = 'data:image/png;base64,AAAA';
  if (process.platform === 'win32') {
    for (const image of [
      undefined,
      'https://evil.test/x.png',
      'data:image/svg+xml;base64,AAAA',
      `data:image/png;base64,${'A'.repeat(40_000)}`,
      'data:image/png;base64,hugeAAAA',
    ]) {
      await assert.rejects(
        Promise.resolve().then(() => badge(appEvent, { count: 3, image })),
        /badge image must be a small PNG/,
      );
    }
    assert.deepEqual(calls, []);
    await badge(appEvent, { count: 3, image: png });
    await badge(appEvent, { count: 0 });
    assert.deepEqual(calls, [
      { name: 'setOverlayIcon', args: [png, '3 titles with new chapters'] },
      { name: 'setOverlayIcon', args: [null, ''] },
    ]);
  } else {
    await badge(appEvent, { count: 3, image: png });
    assert.deepEqual(calls, [{ name: 'setBadgeCount', args: [3] }]);
  }
});

test('a source window the app opened by itself may close once the site shows past its check', () => {
  const policy = require('../dist/main/source-browser-policy.js');
  assert.deepEqual(policy.parseOpenBrowserArgs({ sourceId: 'manhuaus' }), {
    sourceId: 'manhuaus',
    closeWhenPassed: false,
  });
  assert.deepEqual(policy.parseOpenBrowserArgs({ sourceId: 'manhuaus', closeWhenPassed: true }), {
    sourceId: 'manhuaus',
    closeWhenPassed: true,
  });
  assert.throws(() =>
    policy.parseOpenBrowserArgs({ sourceId: 'manhuaus', closeWhenPassed: 'yes' }),
  );
  assert.equal(policy.isChallengeTitle('Just a moment...'), true);
  assert.equal(policy.isChallengeTitle('Attention Required! | Cloudflare'), true);
  assert.equal(policy.isChallengeTitle('ManhuaUS - Read Manhua Online'), false);
});
