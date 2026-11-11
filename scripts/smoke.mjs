import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Playwright is an existing dependency of the extensions workspace. Resolve it there
// rather than depending on npm's current hoisting layout.
const requireFromExtensions = createRequire(path.join(root, 'apps/extensions/package.json'));
const requireFromWeb = createRequire(path.join(root, 'apps/web/package.json'));
const { chromium } = requireFromExtensions('playwright');
const electronExecutable = requireFromExtensions('electron');
const nextCli = requireFromWeb.resolve('next/dist/bin/next');
const mode = process.argv[2] ?? 'all';
if (!['browser', 'desktop', 'all'].includes(mode)) {
  throw new Error('Usage: npm run smoke [-- browser|desktop|all]');
}

const source = {
  id: 'smoke-source',
  name: 'Smoke Source',
  lang: 'en',
  base_url: 'https://example.invalid',
  isNSFW: false,
};
const manga = Array.from({ length: 42 }, (_, index) => ({
  id: `smoke-${index + 1}`,
  slug: `smoke-${index + 1}`,
  title: `Smoke Manga ${index + 1}`,
  source: source.id,
  thumbnail_url: '',
}));
const libraryTitles = Array.from({ length: 1_000 }, (_, index) => ({
  id: `perf-title-${index}`,
  slug: `perf-title-${index}`,
  title: `Performance title ${String(index).padStart(4, '0')}`,
  author: 'Fixture author',
  source: source.id,
  thumbnail_url: '',
  in_library: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  chapter_count: 20,
  latest_chapter_date: null,
  unread_count: 20,
  manga_detail: { status: 'ONGOING', genres: '', description: '', artist: null, rating: null },
}));
const smokeChapter = {
  id: 'smoke-chapter-1',
  source_chapter_key: 'smoke-chapter-1',
  manga_id: 'smoke-1',
  url: 'https://example.invalid/chapter-1',
  name: 'Chapter 1',
  scanlator: null,
  is_read: false,
  is_bookmark: false,
  chapter_number: 1,
  last_page_read: 0,
  page_count: 2,
  fetched_at: null,
  release_date: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};
const readerChapters = Array.from({ length: 50_000 }, (_, index) => ({
  ...smokeChapter,
  id: `smoke-chapter-${index + 1}`,
  name: `Chapter ${index + 1}`,
  chapter_number: index + 1,
}));
readerChapters.unshift(
  { ...smokeChapter, id: 'smoke-chapter-0', name: 'Chapter 0', chapter_number: 0 },
  { ...smokeChapter, id: 'smoke-chapter-0.5', name: 'Chapter 0.5', chapter_number: 0.5 },
);
// A second group's release of chapter 4: the long strip reads each release in turn.
readerChapters.splice(
  readerChapters.findIndex((chapter) => chapter.id === 'smoke-chapter-4') + 1,
  0,
  {
    ...smokeChapter,
    id: 'smoke-chapter-4b',
    name: 'Chapter 4 (Group B)',
    chapter_number: 4,
    scanlator: 'Group B',
  },
);
// Stored as before app-owned chapter ids: the row id is the source's key.
for (const chapter of readerChapters) chapter.source_chapter_key = chapter.id;
/** A plain grey PNG of the given size: real pages for the reader's shape-dependent features
 * (spread pairing, rotation, webtoon detection) and a real image to set as a cover. */
const fixturePngs = new Map();
function fixturePng(width, height) {
  const key = `${width}x${height}`;
  if (!fixturePngs.has(key))
    fixturePngs.set(
      key,
      greyPng(width, height, () => 0x90),
    );
  return fixturePngs.get(key);
}
/** A greyscale PNG whose pixel at (x, y) is `shade(x, y)` (0 black – 255 white). */
function greyPng(width, height, shade) {
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width);
    row[0] = 0; // filter: none
    for (let x = 0; x < width; x++) row[1 + x] = shade(x, y);
    return row;
  });
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}
/** A white 800x1200 page of four grey panels in a 2x2 grid, for guided view. */
const panelPagePng = greyPng(800, 1200, (x, y) => {
  const inPanel = (v, size) =>
    (v >= 40 && v < size / 2 - 20) || (v >= size / 2 + 20 && v < size - 40);
  return inPanel(x, 800) && inPanel(y, 1200) ? 0x50 : 0xff;
});
/** Pages the browser draws itself (Japanese text needs the system's fonts), by name. */
const drawnPages = new Map();
const translateRequests = [];
/** Reading history the fixture returns; empty except in the reading-goal stage. */
let fixtureHistory = [];
/** Chapters whose pages have real shapes: one with a double page among normal ones, one
 * of webtoon-tall pages. */
const shapedChapters = {
  'smoke-chapter-2': ['800x1200', '1600x1000', '800x1200', '800x1200'],
  'smoke-chapter-3': ['800x4000', '800x4000', '800x4000'],
  // Guided view, translation and enhancement: a panel grid, vertical Japanese, a small page.
  'smoke-chapter-4': ['panels', 'japanese', '300x450'],
  'smoke-chapter-4b': ['300x450', '300x450'],
};
const coverUploads = [];
const alertChannels = [];
let searchAttempts = 0;
let browseRequests = [];
let browseSearchRequests = [];
let apiOffline = false;
let fixtureSyncRevoked = false;
let fixtureRestoreComplete = false;
let fixtureLargeLibrary = true;
let fixtureCategories = [];
/** Puts a title the fixture source also lists into the library. */
let fixtureSourceTitleInLibrary = false;
const syncPushPayloads = [];
const updateRequests = [];
const downloadRequests = [];
const syncPushRequests = [];
const syncPullRequests = [];
const apiRequests = [];
const syncCookies = [];
const fixtureAccounts = new Map([
  [
    'smoke-reader@example.test',
    {
      id: 'smoke-account',
      email: 'smoke-reader@example.test',
      display_name: 'Smoke Reader',
      created_at: new Date(0).toISOString(),
      sessionId: 'smoke-session',
    },
  ],
  [
    'second-reader@example.test',
    {
      id: 'second-smoke-account',
      email: 'second-reader@example.test',
      display_name: 'Second Smoke Reader',
      created_at: new Date(0).toISOString(),
      sessionId: 'second-smoke-session',
    },
  ],
]);
const fixtureSessions = new Map();
const fixtureServerTime = '2026-10-11T00:00:00.000Z';
const restoreJobs = new Map();
const restorePreviews = [];

const api = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  apiRequests.push(url.pathname);
  if (url.pathname.startsWith('/api/sync/')) syncCookies.push(request.headers.cookie ?? '');
  const sessionId = /(?:^|;\s*)pm_session=([^;]*)/.exec(request.headers.cookie ?? '')?.[1];
  const fixtureAccount = sessionId ? fixtureSessions.get(sessionId) : null;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? 'http://127.0.0.1');
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }
  if (apiOffline) {
    response.writeHead(503);
    response.end(JSON.stringify({ success: false, message: 'Fixture API offline' }));
    return;
  }
  if (fixtureSyncRevoked && url.pathname.startsWith('/api/sync/')) {
    response.writeHead(401);
    response.end(JSON.stringify({ success: false, message: 'Session expired' }));
    return;
  }
  let data = [];
  if (url.pathname === '/api/auth/me') {
    data = { user: fixtureAccount ? { ...fixtureAccount } : null };
    if (data.user) delete data.user.sessionId;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const account = fixtureAccounts.get(payload.email);
      if (!account) {
        response.writeHead(401);
        response.end(JSON.stringify({ success: false, message: 'Unknown fixture account' }));
        return;
      }
      fixtureSessions.set(account.sessionId, account);
      response.setHeader(
        'Set-Cookie',
        `pm_session=${account.sessionId}; HttpOnly; SameSite=Lax; Path=/`,
      );
      response.writeHead(200);
      response.end(
        JSON.stringify({
          success: true,
          message: 'Logged in',
          data: { user: { ...account, sessionId: undefined } },
        }),
      );
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    if (sessionId) fixtureSessions.delete(sessionId);
    response.setHeader('Set-Cookie', 'pm_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/');
    response.writeHead(200);
    response.end(JSON.stringify({ success: true, message: 'Logged out', data: null }));
    return;
  }
  // Library update: the first two titles each have one new chapter, the rest have none.
  const updateMatch = url.pathname.match(
    new RegExp(`^/api/source/${source.id}/manga/([^/]+)/updates$`),
  );
  if (request.method === 'POST' && updateMatch) {
    const slug = decodeURIComponent(updateMatch[1]);
    updateRequests.push(slug);
    const fresh = ['perf-title-0', 'perf-title-1'].includes(slug);
    data = {
      newChapters: fresh ? 1 : 0,
      newChapterList: fresh
        ? [{ source_chapter_key: `${slug}-chapter-21`, chapter_number: 21, name: 'Chapter 21' }]
        : [],
    };
  }
  if (request.method === 'POST' && url.pathname === '/api/downloads/chapter') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      downloadRequests.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      response.writeHead(200);
      response.end(
        JSON.stringify({
          success: true,
          message: 'Queued',
          data: {
            id: `fixture-download-${downloadRequests.length}`,
            status: 'QUEUED',
            progress: 0,
            message: '',
          },
        }),
      );
    });
    return;
  }
  if (url.pathname === '/api/downloads/directory') data = { path: '' };
  if (url.pathname === '/api/manga') {
    // Paged like the real route: the app reads until a page comes back short.
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 200);
    data = [
      ...(fixtureLargeLibrary ? libraryTitles : []),
      ...(fixtureSourceTitleInLibrary
        ? [{ ...libraryTitles[0], id: 'smoke-2-row', slug: 'smoke-2', title: 'Smoke Manga 2' }]
        : []),
    ].slice(offset, offset + limit);
  }
  if (url.pathname === '/api/library') data = [];
  if (url.pathname === '/api/category/state') data = fixtureCategories;
  if (url.pathname === '/api/library/release-estimates') {
    const day = 24 * 60 * 60 * 1000;
    const estimate = (manga_id, inDays) => ({
      manga_id,
      interval_days: 7,
      next_expected_at: new Date(Date.now() + inDays * day).toISOString(),
      last_chapter_at: new Date(Date.now() + (inDays - 7) * day).toISOString(),
    });
    data = fixtureLargeLibrary
      ? [estimate('perf-title-0', 3), estimate('perf-title-1', -2), estimate('not-in-library', 1)]
      : [];
  }
  if (url.pathname === '/api/downloads/stats') {
    data = {
      total: 0,
      completed: 0,
      inProgress: 0,
      failed: 0,
      totalSize: 0,
      storageLimit: 10 * 1024 ** 3,
      freeBytes: null,
    };
  }
  if (url.pathname === '/api/sync/generation') data = { generation: 0 };
  if (url.pathname === '/api/sync/pull') {
    syncPullRequests.push({
      cookie: request.headers.cookie ?? '',
      since: url.searchParams.get('since'),
    });
    data = {
      generation: 0,
      server_time: fixtureServerTime,
      next_since: fixtureServerTime,
      has_more: false,
      library: [],
      manga_state: [],
      chapter_state: [],
      manga_category: [],
      history: [],
      categories: [],
    };
  }
  if (request.method === 'POST' && url.pathname === '/api/sync/push') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      syncPushPayloads.push(payload);
      syncPushRequests.push({ cookie: request.headers.cookie ?? '', payload });
      const result = Object.fromEntries(
        ['library', 'manga_state', 'chapter_state', 'manga_category', 'history'].map((domain) => [
          domain,
          { applied: Array.isArray(payload[domain]) ? payload[domain].length : 0, failed: [] },
        ]),
      );
      response.writeHead(200);
      response.end(JSON.stringify({ success: true, message: 'Pushed', data: result }));
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/restore/jobs') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const backup = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      restoreJobs.set(backup.jobId, {
        id: backup.jobId,
        state: 'running',
        result: {
          restoredManga: backup.manga?.length ?? 0,
          restoredProgress: 0,
          restoredHistory: 0,
        },
        progress: null,
      });
      response.writeHead(202);
      response.end(
        JSON.stringify({
          success: true,
          message: 'Restore queued',
          data: { id: backup.jobId, state: 'queued' },
        }),
      );
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/restore/preview') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      restorePreviews.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      response.writeHead(200);
      response.end(
        JSON.stringify({
          success: true,
          message: 'Restore preview',
          data: {
            matchingTitles: 0,
            addedTitles: 0,
            importedTitles: 0,
            catalogRowsUpdated: 0,
            catalogUpdateExamples: [],
            retainedHistory: 0,
            addedHistory: 0,
          },
        }),
      );
    });
    return;
  }
  const restoreJobMatch = /^\/api\/restore\/jobs\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && restoreJobMatch) {
    const job = restoreJobs.get(decodeURIComponent(restoreJobMatch[1]));
    if (!job) {
      response.writeHead(404);
      response.end(JSON.stringify({ success: false, message: 'Restore job not found' }));
      return;
    }
    data = fixtureRestoreComplete ? { ...job, state: 'succeeded' } : job;
  }
  if (url.pathname === '/api/manga/details/smoke-1') {
    data = {
      ...manga[0],
      author: 'Smoke Author',
      thumbnail_url: '',
      in_library: false,
      status: 'ONGOING',
      genres: '',
      description: '',
      rating: null,
      artist: null,
      chapters: [smokeChapter],
    };
  }
  if (url.pathname === '/api/chapter/smoke-1') data = readerChapters;
  // A linked source of smoke-1 with one chapter past its last.
  if (url.pathname === '/api/manga/smoke-1/links')
    data = {
      primary_id: 'smoke-1',
      links: [
        {
          id: 'smoke-link-1',
          priority: 0,
          linked: {
            id: 'smoke-linked',
            title: 'Smoke Manga 1 elsewhere',
            author: 'Smoke Author',
            slug: 'smoke-linked',
            source: source.id,
            thumbnail_url: '',
          },
        },
      ],
    };
  if (url.pathname === '/api/chapter/smoke-linked')
    data = [
      {
        ...smokeChapter,
        id: 'linked-50001',
        source_chapter_key: 'linked-50001',
        manga_id: 'smoke-linked',
        name: 'Chapter 50001',
        chapter_number: 50001,
      },
    ];
  if (
    url.pathname.startsWith(`/api/source/${source.id}/chapter/smoke-chapter-`) &&
    url.pathname.endsWith('/pages')
  ) {
    const shaped = shapedChapters[url.pathname.split('/').at(-2)];
    data = shaped
      ? {
          items: shaped.map((size, index) => ({
            index: index + 1,
            image_url: `https://example.invalid/fixture/${size}.png?page=${index + 1}`,
          })),
          pagination: { limit: 100, offset: 0, total: shaped.length },
        }
      : {
          items: [1, 2].map((index) => ({
            index,
            image_url: `https://example.invalid/page-${index}.jpg`,
          })),
          pagination: { limit: 100, offset: 0, total: 2 },
        };
  }
  if (url.pathname === '/api/notification-channels' && request.method === 'GET')
    data = alertChannels;
  if (url.pathname === '/api/history' && request.method === 'GET') data = fixtureHistory;
  if (url.pathname === '/api/translate/status')
    data = { enabled: true, provider: 'libretranslate', source: 'ja' };
  if (url.pathname === '/api/translate' && request.method === 'POST') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      translateRequests.push(body);
      response.writeHead(200);
      response.end(
        JSON.stringify({
          success: true,
          message: 'OK',
          data: { translations: body.texts.map((_, index) => `Translated line ${index + 1}`) },
        }),
      );
    });
    return;
  }
  if (url.pathname === '/api/notification-channels' && request.method === 'POST') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const channel = {
        id: `channel-${alertChannels.length + 1}`,
        kind: body.kind,
        name: body.name,
        enabled: true,
        destination: new URL(body.url).host,
        last_sent_at: null,
        last_error: null,
      };
      alertChannels.push(channel);
      response.writeHead(201);
      response.end(
        JSON.stringify({ success: true, message: 'Alert channel added', data: channel }),
      );
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/manga/smoke-1/override/cover') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      coverUploads.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      response.writeHead(200);
      response.end(JSON.stringify({ success: true, message: 'Cover saved', data: null }));
    });
    return;
  }
  if (url.pathname === '/api/source/sources') data = [source];
  if (url.pathname === `/api/source/${source.id}/manga`) {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    browseRequests.push({ offset, limit });
    data = manga.slice(offset, offset + limit);
  }
  if (url.pathname === `/api/source/${source.id}/filters`) data = [];
  // Cursor-paged browsing (what the app uses now): the cursor is the next offset.
  if (url.pathname === `/api/source/${source.id}/capabilities`) {
    data = {
      latest: true,
      search: true,
      filters: true,
      languageFilter: false,
      urlSearch: false,
      nativePagination: true,
    };
  }
  const pageOf = (list, offset, limit) => {
    const items = list.slice(offset, offset + limit);
    const hasMore = offset + limit < list.length;
    return { items, hasMore, ...(hasMore ? { nextCursor: `offset:${offset + limit}` } : {}) };
  };
  const cursorOffset = () => Number((url.searchParams.get('cursor') ?? 'offset:0').split(':')[1]);
  if (url.pathname === `/api/source/${source.id}/catalogue`) {
    const offset = cursorOffset();
    const limit = Number(url.searchParams.get('limit') ?? 20);
    browseRequests.push({ offset, limit });
    data = pageOf(manga, offset, limit);
  }
  if (url.pathname === `/api/source/${source.id}/search-page`) {
    const offset = cursorOffset();
    const limit = Number(url.searchParams.get('limit') ?? 20);
    if (url.searchParams.get('query') === 'Smoke Manga 42') {
      browseSearchRequests.push({ limit, offset });
      data = pageOf([manga[41]], 0, limit);
    } else {
      searchAttempts++;
      if (searchAttempts <= 1) {
        response.writeHead(503);
        response.end(JSON.stringify({ success: false, message: 'Temporary fixture failure' }));
        return;
      }
      data = pageOf(manga.slice(0, 1), 0, limit);
    }
  }
  if (url.pathname === `/api/source/${source.id}/search`) {
    if (url.searchParams.get('query') === 'Smoke Manga 42') {
      browseSearchRequests.push({
        limit: Number(url.searchParams.get('limit')),
        offset: Number(url.searchParams.get('offset')),
      });
      data = [manga[41]];
      response.writeHead(200);
      response.end(JSON.stringify({ success: true, message: 'OK', data }));
      return;
    }
    searchAttempts++;
    // React Strict Mode may start the initial effect twice in Next dev.
    if (searchAttempts <= 1) {
      response.writeHead(503);
      response.end(JSON.stringify({ success: false, message: 'Temporary fixture failure' }));
      return;
    }
    data = manga.slice(0, 1);
  }
  response.writeHead(200);
  response.end(JSON.stringify({ success: true, message: 'OK', data }));
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function freePort() {
  const server = createTcpServer();
  const port = await listen(server);
  await close(server);
  return port;
}
async function ready(url, child, output) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Web process exited with ${child.exitCode}: ${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* Next may still be compiling. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Web app did not become ready at ${url}: ${output()}`);
}

let web;
let browser;
let desktop;
let desktopProcess;
let desktopOutput = '';
let temporaryProfile;
let webOutput = '';
try {
  const apiPort = await listen(api);
  const webPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}/api`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  web = spawn(
    process.execPath,
    [nextCli, 'dev', '--port', String(webPort), '--hostname', '127.0.0.1'],
    {
      cwd: path.join(root, 'apps/web'),
      env: { ...process.env, NEXT_PUBLIC_API_URL: apiUrl, PROJEKT_MANGA_API_PORT: String(apiPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [web.stdout, web.stderr])
    stream.on('data', (chunk) => {
      webOutput = (webOutput + chunk.toString()).slice(-4000);
    });
  await ready(`${webUrl}/discover`, web, () => webOutput);

  if (mode !== 'desktop') {
    browser = await chromium.launch();
    const browserContext = await browser.newContext();
    await browserContext.tracing.start({ screenshots: true, snapshots: true });
    const evidenceDirectory = path.join(root, 'build', 'v2-browser');
    await mkdir(evidenceDirectory, { recursive: true });
    const page = await browserContext.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    const browserRequests = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/')) browserRequests.push(request.url());
    });
    await page.addInitScript(() => {
      if (localStorage.getItem('projekt-manga:state:v1')) return;
      localStorage.setItem(
        'projekt-manga:state:v1',
        JSON.stringify({ settings: { automaticLibraryUpdates: false } }),
      );
    });
    const libraryLoadStartedAt = performance.now();
    await page.goto(`${webUrl}/`);
    await page.getByRole('heading', { name: 'My Library' }).waitFor();
    await page.getByText('Showing 1000', { exact: true }).waitFor();
    await page.locator('main a[href^="/manga/perf-title-"]').first().waitFor();
    const initiallyMountedLibraryCards = await page
      .locator('main a[href^="/manga/perf-title-"]')
      .count();
    const libraryVisibleMs = performance.now() - libraryLoadStartedAt;
    // Shared CI runners are noisy (~1.4s locally, 2.1s seen on GitHub's), so CI gets headroom;
    // the budget still catches a regression that renders the whole list eagerly.
    const libraryVisibleBudgetMs = process.env.CI ? 4_000 : 2_000;
    assert.ok(
      libraryVisibleMs < libraryVisibleBudgetMs,
      `A 1,000-title library should become visible within ${libraryVisibleBudgetMs.toLocaleString('en-US')} ms; took ${Math.round(libraryVisibleMs)} ms`,
    );
    assert.ok(
      initiallyMountedLibraryCards <= 120,
      `A 1,000-title library should progressively mount at most 120 cards initially; got ${initiallyMountedLibraryCards}`,
    );
    console.info(
      `[library-load-benchmark] titles=${libraryTitles.length} visible_ms=${Math.round(libraryVisibleMs)} initial_cards=${initiallyMountedLibraryCards}`,
    );
    await page.locator('.splash-root').waitFor({ state: 'detached' });
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: path.join(evidenceDirectory, `library-${width}.png`) });
      const layout = await page.evaluate(() => ({
        width: window.innerWidth,
        document: document.documentElement.scrollWidth,
        outside: [...document.querySelectorAll('main *')]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 8)
          .map((el) => ({
            tag: el.tagName,
            text: el.textContent?.slice(0, 60),
            right: el.getBoundingClientRect().right,
          })),
      }));
      assert.ok(
        layout.document <= width,
        `Library overflows ${width}px: ${JSON.stringify(layout)}`,
      );
    }
    // The compact grid puts each title on its cover; Grid view puts it back underneath.
    const chooseLibraryView = async (name) => {
      await page.getByRole('button', { name: /^Library view:/ }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
      // Reopening during its closing animation would be dismissed by the focus returning.
      await page.getByRole('menu').waitFor({ state: 'detached' });
    };
    await chooseLibraryView('Compact');
    await page.locator('main a[href^="/manga/perf-title-"] .relative h3').first().waitFor();
    await chooseLibraryView('Grid');
    await page
      .locator('main a[href^="/manga/perf-title-"] .relative h3')
      .first()
      .waitFor({ state: 'detached' });
    // Upcoming groups titles by expected release day, past-due ones first, and leaves out
    // estimates for titles that aren't in the library.
    await page.getByRole('link', { name: 'Upcoming releases' }).click();
    await page.getByRole('heading', { name: 'Overdue', level: 2 }).waitFor();
    await page.getByText('Performance title 0001', { exact: true }).waitFor();
    await page.getByText('Performance title 0000', { exact: true }).waitFor();
    assert.equal(await page.locator('main section[id^="upcoming-"]').count(), 2);
    await page.goBack();
    await page.getByText('Showing 1000', { exact: true }).waitFor();
    // Automatic downloads: an update limited to the "Smoke updates" category checks only its
    // two titles, and only the one also in "Smoke downloads" gets its new chapter queued.
    const savedAppState = await page.evaluate(() => {
      const key = 'projekt-manga:state:v1';
      const saved = localStorage.getItem(key);
      const state = JSON.parse(saved || '{}');
      state.settings = {
        ...state.settings,
        autoDownloadNew: 'category:Smoke downloads',
        updateIncludeCategories: JSON.stringify(['Smoke updates']),
      };
      localStorage.setItem(key, JSON.stringify(state));
      return saved;
    });
    fixtureCategories = [
      { id: 'smoke-updates', name: 'Smoke updates', manga_ids: ['perf-title-0', 'perf-title-1'] },
      { id: 'smoke-downloads', name: 'Smoke downloads', manga_ids: ['perf-title-0'] },
    ];
    await page.reload();
    await page.getByText('Showing 1000', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Update library', exact: true }).click();
    const downloadDeadline = Date.now() + 15_000;
    while (
      (downloadRequests.length === 0 || updateRequests.length < 2) &&
      Date.now() < downloadDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 200));
    await page.getByRole('button', { name: 'Update library', exact: true }).waitFor();
    assert.deepEqual(
      [...updateRequests].sort(),
      ['perf-title-0', 'perf-title-1'],
      'The update must check only the included category',
    );
    assert.equal(downloadRequests.length, 1, 'Only the download category gets new chapters');
    assert.equal(downloadRequests[0].mangaSlug, 'perf-title-0');
    assert.equal(downloadRequests[0].chapter?.id, 'perf-title-0-chapter-21');
    await page.evaluate(
      (saved) => localStorage.setItem('projekt-manga:state:v1', saved ?? '{}'),
      savedAppState,
    );
    fixtureCategories = [];
    await page.reload();
    await page.getByText('Showing 1000', { exact: true }).waitFor();
    console.log('Browser auto-download smoke passed: category-limited update queued one download.');
    // The command palette opens on Ctrl+Shift+P and finds a library title.
    await page.keyboard.press('Control+Shift+P');
    const paletteInput = page.getByPlaceholder('Search titles, pages, settings…');
    await paletteInput.fill('Performance title 0042');
    await page.getByRole('option', { name: 'Performance title 0042' }).waitFor();
    await page.keyboard.press('Escape');
    await paletteInput.waitFor({ state: 'detached' });
    console.log('Browser command palette passed: opens on Ctrl+Shift+P and finds titles.');
    // Selecting a title opens the selection toolbar; the Unread filter narrows the grid.
    await page.locator('[data-library-selection]').first().focus();
    await page.keyboard.press('Space');
    await page.getByRole('toolbar', { name: 'Selected library titles' }).waitFor();
    await page.getByText('1 selected', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Clear title selection' }).click();
    await page
      .getByRole('toolbar', { name: 'Selected library titles' })
      .waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Unread', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Unread', exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    await page.getByRole('button', { name: 'Unread', exact: true }).click();
    await page.goto(`${webUrl}/discover`);
    await page.getByRole('heading', { name: 'Sources' }).waitFor();
    try {
      await page.getByText('Smoke Source').first().waitFor();
    } catch (error) {
      throw new Error(
        `Fixture source did not render. Body: ${(await page.locator('body').innerText()).slice(0, 1500)}; browser API requests: ${JSON.stringify(browserRequests)}; fixture requests: ${JSON.stringify(apiRequests)}; web output: ${webOutput}`,
        { cause: error },
      );
    }
    await page.goto(`${webUrl}/discover/popular?source=${source.id}`);
    await page.getByText('Smoke Manga 1').first().waitFor();
    assert.equal(browseRequests[0]?.limit, 20, 'Browse must request 20 items at a time');
    await page
      .getByRole('textbox', { name: 'Search all titles on this source' })
      .fill('Smoke Manga 42');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByText('Smoke Manga 42').first().waitFor();
    assert.ok(browseSearchRequests.some((request) => request.offset === 0 && request.limit === 20));
    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.getByText('Smoke Manga 1').first().waitFor();
    await page.getByRole('button', { name: 'Load more' }).click();
    await page.getByText('Smoke Manga 21').first().waitFor();
    assert.ok(browseRequests.some((request) => request.offset === 20 && request.limit === 20));
    await page.goto(`${webUrl}/settings`);
    await page.goBack();
    await page.getByText('Smoke Manga 21').first().waitFor();

    // "Hide titles already in your library": off by default, then hides only library titles.
    fixtureSourceTitleInLibrary = true;
    const browseUrl = `${webUrl}/discover/popular?source=${source.id}`;
    const hideSwitch = () =>
      page.getByRole('switch', { name: 'Hide titles already in your library' });
    const smokeTwoCard = () => page.getByRole('link', { name: 'Preview "Smoke Manga 2"' });
    await page.goto(browseUrl);
    await page.getByText('Smoke Manga 1').first().waitFor();
    await smokeTwoCard().waitFor();
    await page.goto(`${webUrl}/settings#extensions`);
    await hideSwitch().waitFor();
    assert.equal(await hideSwitch().getAttribute('aria-checked'), 'false');
    await hideSwitch().click();
    assert.equal(await hideSwitch().getAttribute('aria-checked'), 'true');
    await page.goto(browseUrl);
    await page.getByText('1 title already in your library is hidden.').waitFor();
    await page.getByText('Smoke Manga 3').first().waitFor();
    assert.equal(await smokeTwoCard().count(), 0, 'A library title must be hidden');
    await page.goto(`${webUrl}/settings#extensions`);
    await hideSwitch().click();
    assert.equal(await hideSwitch().getAttribute('aria-checked'), 'false');
    await page.goto(browseUrl);
    await smokeTwoCard().waitFor();
    fixtureSourceTitleInLibrary = false;
    // Alerts outside the app: a webhook channel added in Settings shows by its host only.
    await page.goto(`${webUrl}/settings#notifications`);
    try {
      await page.getByRole('button', { name: 'Add a channel' }).click({ timeout: 60_000 });
    } catch (error) {
      throw new Error(
        `Alert channels did not render. Page errors: ${JSON.stringify(pageErrors)}; URL: ${page.url()}; body: ${(await page.locator('main').innerText()).slice(0, 1500)}`,
        { cause: error },
      );
    }
    await page.getByRole('radio', { name: 'Webhook' }).click();
    await page.getByLabel('Name').fill('Home automation');
    await page.getByLabel('URL').fill('https://hooks.example.com/projekt-manga?secret=1');
    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByText('Home automation', { exact: true }).waitFor();
    await page.getByText(/Webhook · hooks\.example\.com/).waitFor();
    assert.equal(alertChannels.length, 1);
    assert.equal(await page.getByText('secret=1').count(), 0, 'The channel URL is never shown');
    alertChannels.length = 0;
    console.log('Browser alert channels passed: a webhook channel is added from Settings.');
    await page.goto(`${webUrl}/discover?q=smoke`);
    // Every installed source is searched at once; a source that fails offers its own retry.
    try {
      await page.getByRole('button', { name: 'Try again' }).click();
    } catch (error) {
      throw new Error(
        `Search retry button did not appear. Attempts: ${searchAttempts}; body: ${(await page.locator('body').innerText()).slice(0, 1200)}`,
        { cause: error },
      );
    }
    await page.getByText('Smoke Manga 1').first().waitFor();
    assert.ok(searchAttempts >= 2, 'Failed search must be retried');
    await page.setViewportSize({ width: 375, height: 812 });
    const mobileLayout = await page.evaluate(() => ({
      navBottom: document.querySelector('nav').getBoundingClientRect().bottom,
      contentTop: document.querySelector('main').firstElementChild.getBoundingClientRect().top,
      searchWidth: document.querySelector('nav input').getBoundingClientRect().width,
    }));
    assert.ok(
      mobileLayout.contentTop >= mobileLayout.navBottom,
      'Mobile nav must not cover page content',
    );
    assert.ok(mobileLayout.searchWidth >= 70, 'Mobile search must remain usable');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${webUrl}/settings`);
    await page.getByRole('button', { name: 'Privacy', exact: true }).click();
    await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
      name: 'smoke-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ version: 2, manga: [], library: [], history: [], downloads: [] }),
      ),
    });
    await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor();
    fixtureRestoreComplete = false;
    await page.getByRole('button', { name: 'Merge backup', exact: true }).click();
    await page.waitForFunction(
      () => localStorage.getItem('projekt-manga-pending-restore') !== null,
      { timeout: 10_000 },
    );
    await page.getByRole('status', { name: 'Restoring your library' }).waitFor();
    const secondBrowserWindow = await browserContext.newPage();
    await secondBrowserWindow.goto(`${webUrl}/settings`);
    await secondBrowserWindow.getByRole('status', { name: 'Restoring your library' }).waitFor();
    fixtureRestoreComplete = true;
    await page.waitForFunction(
      () => localStorage.getItem('projekt-manga-pending-restore') === null,
      { timeout: 15_000 },
    );
    await secondBrowserWindow.waitForFunction(
      () => localStorage.getItem('projekt-manga-pending-restore') === null,
      { timeout: 15_000 },
    );
    await secondBrowserWindow.close();
    assert.equal(restoreJobs.size, 1, 'Browser restore must submit one durable job');
    restoreJobs.clear();
    restorePreviews.length = 0;
    fixtureRestoreComplete = false;
    console.log(
      'Browser smoke passed: source search, paging, hiding library titles, cross-window restore status, retry, and mobile nav.',
    );
    await page.route('**/api/source/image-proxy**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
      }),
    );
    await page.goto(`${webUrl}/reader/smoke-1`);
    await page.getByText('Chapter 1', { exact: false }).first().waitFor();
    await page.locator('img[alt*="page"]').first().waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.waitForTimeout(900);
    assert.ok(
      apiRequests.some((request) => request.includes('/mark-by-page')),
      'Reading a page must persist progress through the API',
    );
    const browserMetrics = await page.context().newCDPSession(page);
    await browserMetrics.send('HeapProfiler.enable');
    await browserMetrics.send('HeapProfiler.collectGarbage');
    const domBefore = await browserMetrics.send('Memory.getDOMCounters');
    const heapBefore = await browserMetrics.send('Runtime.getHeapUsage');
    const chapterListRenderSamples = [];
    const currentChapterLink = page.locator(
      'a[href="/reader/smoke-1?ch=1&chapterId=smoke-chapter-1"]',
    );
    for (let sample = 0; sample < 3; sample++) {
      if (sample > 0) {
        await page.getByRole('button', { name: 'Close chapter list' }).click();
        await currentChapterLink.waitFor({ state: 'detached' });
      }
      // The immersive chrome hides after 2.2s idle, which the GC calls above can outlast on
      // a slow runner. Any keydown reveals it; Shift is bound to no reader shortcut.
      await page.keyboard.press('Shift');
      const started = performance.now();
      await page.getByRole('button', { name: 'Chapter list', exact: true }).click();
      await currentChapterLink.waitFor({ state: 'attached' });
      chapterListRenderSamples.push(performance.now() - started);
    }
    const chapterListRenderMs = chapterListRenderSamples.sort((a, b) => a - b)[
      Math.floor(chapterListRenderSamples.length / 2)
    ];
    const chapterListDom = await page.evaluate(() => ({
      chapterLinks: document.querySelectorAll('a[href^="/reader/smoke-1?ch="]').length,
    }));
    await browserMetrics.send('HeapProfiler.collectGarbage');
    const domAfter = await browserMetrics.send('Memory.getDOMCounters');
    const heapAfter = await browserMetrics.send('Runtime.getHeapUsage');
    await browserMetrics.detach();
    assert.ok(
      chapterListDom.chapterLinks <= 26,
      `The chapter picker should mount at most 26 rows, observed ${chapterListDom.chapterLinks}`,
    );
    assert.ok(
      chapterListRenderMs < 2_000,
      `50,000 chapter links must render under 2,000 ms (observed ${Math.round(chapterListRenderMs)} ms)`,
    );
    const heapDeltaBytes =
      heapAfter.usedSize -
      heapBefore.usedSize +
      heapAfter.embedderHeapUsedSize -
      heapBefore.embedderHeapUsedSize +
      heapAfter.backingStorageSize -
      heapBefore.backingStorageSize;
    console.info(
      `[reader-list-benchmark] chapters=${readerChapters.length} render_median_ms=${Math.round(chapterListRenderMs)} dom_node_delta=${domAfter.nodes - domBefore.nodes} heap_delta_bytes=${heapDeltaBytes}`,
    );
    await currentChapterLink.focus();
    await page.keyboard.press('Home');
    const newestChapterLink = page.locator(
      'a[href="/reader/smoke-1?ch=50000&chapterId=smoke-chapter-50000"]',
    );
    await newestChapterLink.waitFor({ state: 'attached' });
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('href') ===
        '/reader/smoke-1?ch=50000&chapterId=smoke-chapter-50000',
    );
    await page.keyboard.press('End');
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('href') ===
        '/reader/smoke-1?ch=0&chapterId=smoke-chapter-0',
    );
    await page.setViewportSize({ width: 375, height: 812 });
    const mobileReader = await page.evaluate(() => {
      const controls = ['Previous', 'Next'].map((label) => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) => candidate.getAttribute('aria-label') === label,
        );
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, visible: rect.width > 0 && rect.height > 0 };
      });
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        controls,
      };
    });
    assert.ok(
      mobileReader.documentWidth <= mobileReader.viewportWidth,
      `Reader overflows the ${mobileReader.viewportWidth}px viewport: ${mobileReader.documentWidth}px`,
    );
    for (const [index, label] of ['Previous', 'Next'].entries()) {
      const control = mobileReader.controls[index];
      assert.ok(control?.visible, `${label} control must remain visible in the mobile reader`);
      assert.ok(
        control.left >= 0 && control.right <= mobileReader.viewportWidth,
        `${label} control must remain within the mobile viewport`,
      );
    }
    console.log(
      'Browser reader smoke passed: anonymous chapter load, page progress, and narrow viewport controls.',
    );
    await page.getByRole('button', { name: 'Close chapter list' }).click();
    // Settings > Reader > Colour filter reaches the page image, and the page image menu is
    // offered. Set through stored state, then cleared so later stages see plain pages.
    const setReaderSetting = (key, value) =>
      page.evaluate(
        ([settingKey, settingValue]) => {
          const storageKey = 'projekt-manga:state:v1';
          const state = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
          state.settings = { ...state.settings, [settingKey]: settingValue };
          localStorage.setItem(storageKey, JSON.stringify(state));
        },
        [key, value],
      );
    await setReaderSetting('readerColorFilter', 'Grayscale');
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector('img[alt*="page"]')?.style.filter === 'grayscale(1)',
      undefined,
      { polling: 250 },
    );
    await page.keyboard.press('Shift');
    await page.getByRole('button', { name: 'Page image', exact: true }).waitFor();
    await setReaderSetting('readerTint', 'Amber');
    await page.reload();
    await page.locator('[data-reader-tint="Amber"]').waitFor({ state: 'attached' });
    await setReaderSetting('readerTint', 'Custom');
    await setReaderSetting('readerTintCustomColor', '#123456');
    await setReaderSetting('readerTintBlend', 'Screen');
    await page.reload();
    const customTint = page.locator('[data-reader-tint="Custom"]');
    await customTint.waitFor({ state: 'attached' });
    assert.deepEqual(
      await customTint.evaluate((el) => [el.style.backgroundColor, el.style.mixBlendMode]),
      ['rgb(18, 52, 86)', 'screen'],
    );
    await setReaderSetting('readerTintBlend', 'Multiply');
    await setReaderSetting('readerColorFilter', 'None');
    await setReaderSetting('readerTint', 'None');
    console.log('Browser reader image tools passed: colour filter, tint and page image menu.');
    // Reader input: page keys and the wheel move through a single-page chapter, "?" opens
    // the shortcut sheet and right-clicking a page opens its menu.
    await setReaderSetting('pageLayout', 'Single page');
    await page.reload();
    await page.locator('img[alt*="page"]').first().waitFor({ state: 'attached' });
    // The first page shows before the chapter's page count arrives; End pressed while the
    // reader still counts one page has nowhere to go, so wait for the real total first.
    await page.getByText('1 / 2', { exact: true }).first().waitFor({ state: 'attached' });
    await page.keyboard.press('End');
    await page.getByText('2 / 2', { exact: true }).first().waitFor({ state: 'attached' });
    await page.keyboard.press('Home');
    await page.getByText('1 / 2', { exact: true }).first().waitFor({ state: 'attached' });
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, 300);
    await page.getByText('2 / 2', { exact: true }).first().waitFor({ state: 'attached' });
    await page.keyboard.press('?');
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor({ state: 'hidden' });
    await page.locator('img[alt*="page"]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Save page \d+$/ }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem', { name: /^Save page \d+$/ }).waitFor({ state: 'hidden' });
    // Incognito: pages still turn, but nothing about the reading is sent anywhere. The
    // same page change outside incognito saves progress (checked at the start of this
    // stage), so silence here is the incognito gate, not a missed save.
    await setReaderSetting('incognitoMode', true);
    await page.reload();
    await page.locator('img[alt*="page"]').first().waitFor({ state: 'attached' });
    const requestsBefore = apiRequests.length;
    await page.keyboard.press('Home');
    await page.getByText('1 / 2', { exact: true }).first().waitFor({ state: 'attached' });
    await page.waitForTimeout(2000);
    assert.deepEqual(
      apiRequests
        .slice(requestsBefore)
        .filter((request) => /mark-by-page|\/history\/add|\/progress/.test(request)),
      [],
      'Incognito reading must not save progress or history',
    );
    await setReaderSetting('incognitoMode', false);
    await setReaderSetting('pageLayout', 'Two-page spread');
    console.log(
      'Browser reader input passed: page keys, wheel, shortcut sheet, page menu and incognito.',
    );
    await page.goto(`${webUrl}/reader/smoke-1?ch=0`);
    await page.locator('img[alt*="page"]').first().waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to Chapter 0.5' }).click();
    await page.waitForURL(/ch=0\.5&page=1&chapterId=smoke-chapter-0\.5/);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Chapter 0', exact: true }).click();
    await page.waitForURL(/ch=0&page=\d+&chapterId=smoke-chapter-0$/);
    console.log('Browser reader chapter-zero and decimal navigation passed.');
    // Shape-dependent reader features, with real page images of chosen sizes. Registered
    // after the SVG stand-in above, so it is tried first and passes other images back.
    await page.route('**/api/source/image-proxy**', (route) => {
      const target = new URL(route.request().url()).searchParams.get('url') ?? '';
      const size = /\/fixture\/(\d+)x(\d+)\.png/.exec(target);
      if (!size) return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: fixturePng(Number(size[1]), Number(size[2])),
      });
    });
    // Desktop width: on a phone-width screen two-page mode shows single pages.
    await page.setViewportSize({ width: 1280, height: 800 });
    const units = () => page.locator('[data-unit]').count();
    // Two-page mode: the double page gets a screen of its own, and 3 and 4 pair up.
    await setReaderSetting('pageLayout', 'Two-page spread');
    await page.goto(`${webUrl}/reader/smoke-1?ch=2&chapterId=smoke-chapter-2`);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-unit]').length === 3,
      undefined,
      {
        polling: 250,
        timeout: 30_000,
      },
    );
    assert.deepEqual(
      await page
        .locator('[data-unit]')
        .evaluateAll((elements) =>
          elements.map((unit) => unit.querySelectorAll('[data-page]').length),
        ),
      [1, 1, 2],
    );
    // Single page with "rotate wide pages": the double page is turned on its side.
    await setReaderSetting('pageLayout', 'Single page');
    await setReaderSetting('readerRotateWidePages', true);
    await page.reload();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-page="2"] img')].some((img) =>
          img.style.transform.includes('rotate(90deg)'),
        ),
      undefined,
      { polling: 250, timeout: 30_000 },
    );
    assert.equal(await units(), 4);
    await setReaderSetting('readerRotateWidePages', false);
    // Set as cover: the page under the cursor is uploaded as the title's cover.
    await page.locator('[data-page="1"] img').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Set as cover' }).click();
    await page.getByText('Cover updated.').first().waitFor();
    assert.equal(coverUploads.length, 1);
    assert.equal(coverUploads[0].mime, 'image/png');
    assert.deepEqual(
      [...Buffer.from(coverUploads[0].data, 'base64').subarray(0, 4)],
      [137, 80, 78, 71],
      'The uploaded cover is the page image',
    );
    // A chapter of very tall pages read page by page: the reader offers the long strip,
    // and taking it switches this title over.
    await page.goto(`${webUrl}/reader/smoke-1?ch=3&chapterId=smoke-chapter-3`);
    await page
      .getByText('This looks like a webtoon.', { exact: false })
      .waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Use long strip' }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-unit]').length === 0,
      undefined,
      {
        polling: 250,
        timeout: 30_000,
      },
    );
    assert.equal(await page.getByText('This looks like a webtoon.', { exact: false }).count(), 0);
    // Undo this stage's per-title choices so later stages read smoke-1 as before.
    await page.evaluate(() => {
      const key = 'projekt-manga:state:v1';
      const state = JSON.parse(localStorage.getItem(key) ?? '{}');
      for (const name of Object.keys(state.settings ?? {}))
        if (name.includes('reader-override:') || name.includes('webtoon-suggestion-dismissed:'))
          delete state.settings[name];
      localStorage.setItem(key, JSON.stringify(state));
    });
    await setReaderSetting('pageLayout', 'Two-page spread');
    console.log(
      'Browser reader display passed: spread pairing, rotation, set as cover and webtoon suggestion with real page images.',
    );

    // Guided view, translate page and enhance, on chapter 4's real pages. The Japanese page
    // is drawn here, with the system's own Japanese font, and read by the real OCR.
    const japanesePage = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 1200;
      const context = canvas.getContext('2d');
      // Art: hatching over the whole page, then a speech bubble for the text to sit in.
      context.fillStyle = '#fff';
      context.fillRect(0, 0, 800, 1200);
      context.strokeStyle = '#333';
      context.lineWidth = 1.5;
      for (let offset = -1200; offset < 800; offset += 9) {
        context.beginPath();
        context.moveTo(offset, 0);
        context.lineTo(offset + 1200, 1200);
        context.stroke();
      }
      context.beginPath();
      context.ellipse(490, 410, 200, 300, 0, 0, Math.PI * 2);
      context.fillStyle = '#fff';
      context.fill();
      context.lineWidth = 4;
      context.strokeStyle = '#000';
      context.stroke();
      context.fillStyle = '#000';
      context.font = '64px "Yu Gothic", "Meiryo", "MS Gothic", "Noto Sans CJK JP", sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'top';
      ['こんにちは', 'ありがとう'].forEach((line, column) =>
        [...line].forEach((character, row) =>
          context.fillText(character, 560 - column * 140, 220 + row * 76),
        ),
      );
      return canvas.toDataURL('image/png').split(',')[1];
    });
    drawnPages.set('japanese', Buffer.from(japanesePage, 'base64'));
    const webOrigin = new URL(webUrl).origin;
    await page.route('**/api/source/image-proxy**', (route) => {
      const target = new URL(route.request().url()).searchParams.get('url') ?? '';
      const name = /\/fixture\/(panels|japanese|300x450)\.png/.exec(target)?.[1];
      if (!name) return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        // These features read the page's pixels, so the image must be CORS-approved.
        headers: {
          'Access-Control-Allow-Origin': route.request().headers().origin ?? webOrigin,
          'Access-Control-Allow-Credentials': 'true',
        },
        body:
          name === 'panels'
            ? panelPagePng
            : name === 'japanese'
              ? drawnPages.get('japanese')
              : fixturePng(300, 450),
      });
    });
    const chapterFour = (pageNumber) =>
      `${webUrl}/reader/smoke-1?ch=4&page=${pageNumber}&chapterId=smoke-chapter-4`;
    await setReaderSetting('pageLayout', 'Single page');
    await setReaderSetting('readerGuidedView', true);
    await page.goto(chapterFour(1));
    await page.getByText('Panel 1 of 4').waitFor({ timeout: 30_000 });
    // PageDown is "next page" whatever the reading direction; the on-screen "Next" button
    // is the right-hand one, which goes back in a right-to-left title.
    await page.keyboard.press('PageDown');
    await page.getByText('Panel 2 of 4').waitFor();
    // The page is cropped to the panel: the image is scaled up inside its frame.
    assert.match(
      await page
        .locator('[data-page="1"] img')
        .first()
        .evaluate((img) => img.style.width),
      /^2\d\d(\.\d+)?%$/,
    );
    await setReaderSetting('readerGuidedView', false);
    console.log('Browser guided view passed: a 2x2 page is read panel by panel.');

    await page.goto(chapterFour(2));
    await page.waitForFunction(
      () => document.querySelector('[data-page="2"] img')?.complete,
      undefined,
      { polling: 250, timeout: 30_000 },
    );
    await page.locator('[data-page="2"] img').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Translate page' }).click();
    // The first run loads the OCR engine and its Japanese model.
    await page.locator('[data-page="2"][data-translated="true"]').waitFor({ timeout: 180_000 });
    const recognised = translateRequests.at(-1)?.texts.join('') ?? '';
    assert.ok(
      (recognised.match(/[぀-ゟ]/g) ?? []).length >= 4,
      `OCR should read the drawn hiragana; read ${JSON.stringify(recognised)}`,
    );
    await page.getByText('Translated line 1').first().waitFor();
    await page.locator('[data-page="2"] img').first().click({ button: 'right', force: true });
    await page.getByRole('menuitem', { name: 'Show original' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-translated="true"]'));
    console.log(
      `Browser translate page passed: OCR read ${JSON.stringify(recognised)} and the translation was overlaid.`,
    );

    const webgl2 = await page.evaluate(
      () => !!document.createElement('canvas').getContext('webgl2'),
    );
    await setReaderSetting('readerEnhance', true);
    await page.goto(chapterFour(3));
    if (webgl2) {
      await page.locator('[data-page="3"][data-enhanced="true"]').waitFor({ timeout: 30_000 });
      assert.match(
        (await page.locator('[data-page="3"] img').first().getAttribute('src')) ?? '',
        /^blob:/,
      );
      console.log('Browser enhance passed: a 300x450 page shown larger is upscaled on the GPU.');
    } else {
      console.log('Browser enhance skipped: this headless browser has no WebGL2.');
    }
    await setReaderSetting('readerEnhance', false);

    // Bookmark chapter: B toggles the chapter list's bookmark from inside the reader.
    await page.keyboard.press('b');
    await page.getByRole('button', { name: 'Remove chapter bookmark' }).waitFor();
    await page.keyboard.press('b');
    await page.getByRole('button', { name: 'Bookmark chapter', exact: true }).waitFor();
    console.log('Browser reader bookmark key passed.');

    // Long strip with "Skip duplicate chapters" off (the default): after chapter 4 comes
    // Group B's release of the same chapter, not chapter 5.
    await setReaderSetting('pageLayout', 'Long strip');
    await page.goto(chapterFour(1));
    await page
      .getByText('Chapter 4 · Chapter 4', { exact: false })
      .first()
      .waitFor({ timeout: 30_000 });
    const groupB = page.getByText('Chapter 4 · Group B', { exact: false }).first();
    for (let i = 0; i < 40 && !(await groupB.isVisible()); i++) {
      await page.evaluate(() => {
        for (const element of document.querySelectorAll('.overflow-y-auto'))
          element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(250);
    }
    await groupB.waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText(/^Chapter 5 ·/).count(), 0);
    console.log("Browser long strip passed: it reads each group's release in turn.");
    await setReaderSetting('pageLayout', 'Two-page spread');

    // Reading goal and year in manga, from three chapters read today.
    const now = Date.now();
    fixtureHistory = [1, 2, 3].map((chapter) => ({
      id: `history-${chapter}`,
      manga_id: 'smoke-1',
      manga_slug: 'smoke-1',
      source: source.id,
      title: 'Smoke Manga 1',
      chapter_number: chapter,
      last_read: new Date(now - chapter * 60_000).toISOString(),
      time_read: 20 * 60_000,
    }));
    await setReaderSetting('readingGoalCount', 5);
    await setReaderSetting('readingGoalPeriod', 'Week');
    await page.goto(`${webUrl}/`);
    await page
      .getByRole('link', { name: 'Reading goal: 3 of 5 chapters this week' })
      .first()
      .waitFor({ timeout: 30_000 });
    await page.goto(`${webUrl}/year`);
    await page
      .getByRole('heading', { name: `Your ${new Date().getFullYear()} in manga` })
      .waitFor({ timeout: 60_000 });
    await page.getByText('Smoke Manga 1').first().waitFor();
    assert.equal(
      await page
        .locator('dt', { hasText: 'Chapters' })
        .locator('xpath=..')
        .locator('dd')
        .innerText(),
      '3',
    );
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save as image' }).click();
    assert.match((await download).suggestedFilename(), /^projekt-manga-\d{4}\.png$/);
    fixtureHistory = [];
    await setReaderSetting('readingGoalCount', 0);
    console.log('Browser reading goal and year in manga passed.');
    // Linked sources: the title page lists the chapter only the linked source has, and the
    // reader at the last chapter offers to go on there.
    await page.goto(`${webUrl}/manga/smoke-1`);
    await page.getByRole('heading', { name: 'Linked sources' }).waitFor({ timeout: 30_000 });
    await page.getByRole('link', { name: /Ch 50001/ }).waitFor();
    await page.goto(`${webUrl}/reader/smoke-1?ch=50000&chapterId=smoke-chapter-50000`);
    await page.locator('img[alt*="page"]').first().waitFor({ state: 'attached' });
    await page.keyboard.press('End');
    const continueElsewhere = page.getByRole('link', { name: /Read Chapter 50001 on/ });
    await continueElsewhere.waitFor({ timeout: 30_000 });
    assert.match(
      (await continueElsewhere.getAttribute('href')) ?? '',
      /^\/reader\/smoke-linked\?ch=50001&chapterId=linked-50001$/,
    );
    console.log('Browser linked sources passed: chapters only elsewhere, and continuing there.');
    await browserContext.tracing.stop({ path: path.join(evidenceDirectory, 'trace.zip') });
    await writeFile(
      path.join(evidenceDirectory, 'report.json'),
      JSON.stringify(
        {
          viewports: [375, 768, 1440],
          libraryVisibleMs,
          initiallyMountedLibraryCards,
          chapterListRenderMs,
          pageErrors,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(pageErrors, [], 'Browser acceptance must not produce uncaught page errors');
  }

  if (mode !== 'browser') {
    fixtureLargeLibrary = false;
    temporaryProfile = await mkdtemp(path.join(tmpdir(), 'projekt-manga-smoke-'));
    const localComicId = '12345678-1234-4234-8234-123456789abc';
    const localComicDirectory = path.join(
      temporaryProfile,
      'local-archives',
      createHash('sha256').update('anonymous').digest('hex'),
      localComicId,
    );
    await mkdir(localComicDirectory, { recursive: true });
    const interruptedDirectory = path.join(
      path.dirname(localComicDirectory),
      '.partial-87654321-4321-4321-8321-cba987654321',
    );
    await mkdir(interruptedDirectory);
    await writeFile(path.join(interruptedDirectory, '0.png'), Buffer.from('interrupted import'));
    const localPage = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(path.join(localComicDirectory, '0.png'), localPage);
    await writeFile(path.join(localComicDirectory, '1.png'), localPage);
    await writeFile(
      path.join(localComicDirectory, 'manifest.json'),
      JSON.stringify({
        id: localComicId,
        title: 'Fixture local comic',
        importedAt: new Date().toISOString(),
        pages: ['0.png', '1.png'],
      }),
    );
    const debugPort = await freePort();
    const launchDesktop = async () => {
      desktopProcess = spawn(
        electronExecutable,
        [
          '--disable-gpu',
          // Windows pauses rendering for a window it thinks is covered, which stalls every
          // Playwright wait that needs a frame (rAF polling, actionability checks) whenever
          // the smoke window sits behind the terminal.
          '--disable-features=CalculateNativeWinOcclusion',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          `--remote-debugging-port=${debugPort}`,
          path.join(root, 'apps/desktop/scripts/smoke-entry.cjs'),
        ],
        {
          cwd: path.join(root, 'apps/desktop'),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PROJEKT_MANGA_SMOKE_USER_DATA: temporaryProfile,
            PROJEKT_MANGA_WEB_URL: webUrl,
            PROJEKT_MANGA_API_URL: apiUrl,
            PROJEKT_MANGA_MANAGED_SERVERS: '0',
          },
        },
      );
      for (const stream of [desktopProcess.stdout, desktopProcess.stderr])
        stream.on('data', (chunk) => {
          desktopOutput = (desktopOutput + chunk.toString()).slice(-4000);
        });
      const debugUrl = `http://127.0.0.1:${debugPort}/json/version`;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (desktopProcess.exitCode !== null)
          throw new Error(`Electron exited with ${desktopProcess.exitCode}: ${desktopOutput}`);
        try {
          if ((await fetch(debugUrl)).ok) break;
        } catch {
          /* Still starting. */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      desktop = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const context = desktop.contexts()[0];
      let page;
      while (Date.now() < deadline && !page) {
        page = context.pages().find((candidate) => candidate.url().startsWith(webUrl));
        if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!page) throw new Error('Electron did not load the fixture web app');
      await page.waitForFunction(() => window.desktop?.data?.invoke, { timeout: 30_000 });
      return page;
    };
    let page = await launchDesktop();
    await page.goto(`${webUrl}/local`);
    await page.getByRole('link', { name: 'Fixture local comic · 2 pages', exact: true }).waitFor();
    await assert.rejects(stat(interruptedDirectory), { code: 'ENOENT' });
    await page.getByRole('link', { name: 'Fixture local comic · 2 pages', exact: true }).click();
    // Interval polling: requestAnimationFrame polling never fired in the Electron window
    // reached over CDP, though the image decoded within a second.
    await page.waitForFunction(
      () =>
        [...document.images].some(
          (image) => image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0,
        ),
      undefined,
      { polling: 250 },
    );
    await page.keyboard.press('ArrowRight');
    await page.getByText('2 / 2', { exact: true }).first().waitFor();
    // The position is saved a moment after the page turns; reloading before that made this
    // step flaky. Wait until the stored preference holds page 2.
    await page.waitForFunction((id) => {
      for (let index = 0; index < localStorage.length; index += 1) {
        let settings;
        try {
          settings = JSON.parse(localStorage.getItem(localStorage.key(index)) ?? '').settings;
        } catch {
          continue;
        }
        for (const [key, value] of Object.entries(settings ?? {})) {
          if (key.includes(`local-archive-page:${id}`) && JSON.parse(value).value === 2)
            return true;
        }
      }
      return false;
    }, localComicId);
    await page.reload();
    await page.getByText('2 / 2', { exact: true }).first().waitFor();
    assert.equal((await page.evaluate(() => window.desktop.archives.list())).length, 1);
    await desktop.close();
    if (desktopProcess.exitCode === null && desktopProcess.signalCode === null)
      desktopProcess.kill();
    if (desktopProcess.exitCode === null && desktopProcess.signalCode === null)
      await Promise.race([
        new Promise((resolve) => desktopProcess.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    assert.ok(
      desktopProcess.exitCode !== null || desktopProcess.signalCode !== null,
      'The old Electron process must exit before restarting',
    );
    page = await launchDesktop();
    await page.goto(`${webUrl}/local-reader/${localComicId}`);
    await page.getByText('2 / 2', { exact: true }).first().waitFor();
    await page.waitForFunction(() =>
      [...document.images].some(
        (image) => image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0,
      ),
    );
    console.log(
      'Desktop CBZ smoke passed: isolated collection, real IPC image bytes, decoded page and persisted position.',
    );
    // The window's size and position were saved for the next launch, and an app link
    // opened as a new tab (Ctrl+click, middle-click) becomes a second app window.
    const windowState = JSON.parse(
      await readFile(path.join(temporaryProfile, 'window-state.json'), 'utf8'),
    );
    assert.ok(windowState.width >= 1024 && windowState.height >= 680, JSON.stringify(windowState));
    const [secondWindow] = await Promise.all([
      desktop.contexts()[0].waitForEvent('page', { timeout: 15_000 }),
      page.evaluate(() => {
        window.open('/settings', '_blank');
      }),
    ]);
    await secondWindow.waitForURL(`${webUrl}/settings`, { timeout: 30_000 });
    await secondWindow.close();
    console.log('Desktop shell smoke passed: saved window state and a second app window.');
    // Translate page's OCR under the desktop app's Content-Security-Policy: the worker,
    // its WASM core and the Japanese model all load from the app's own /ocr folder. The
    // page drawn in the browser stage is read here with lib/page-ocr.ts's worker settings
    // (the bubble-finding before it is plain canvas work, covered by the browser stage).
    if (drawnPages.has('japanese')) {
      await page.addScriptTag({
        content: await readFile(
          path.join(
            path.dirname(requireFromWeb.resolve('tesseract.js/package.json')),
            'dist/tesseract.min.js',
          ),
          'utf8',
        ),
      });
      const desktopOcr = await page.evaluate(async (pageBase64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${pageBase64}`;
        await image.decode();
        const at = (file) => new URL(file, window.location.origin).href;
        const worker = await window.Tesseract.createWorker('jpn_vert', 1, {
          workerPath: at('/ocr/worker.min.js'),
          corePath: at('/ocr/core'),
          langPath: at('/ocr/lang'),
          workerBlobURL: false,
          gzip: true,
        });
        // The bubble's inside, as the reader crops it, read as one vertical block.
        const crop = document.createElement('canvas');
        crop.width = 300;
        crop.height = 500;
        crop.getContext('2d').drawImage(image, 340, 160, 300, 500, 0, 0, 300, 500);
        await worker.setParameters({ tessedit_pageseg_mode: '5' });
        const { data } = await worker.recognize(crop, {}, { blocks: true, text: true });
        await worker.terminate();
        return data.text.replace(/\s+/g, '');
      }, drawnPages.get('japanese').toString('base64'));
      assert.ok(
        (desktopOcr.match(/[぀-ゟ]/g) ?? []).length >= 4,
        `Desktop OCR should read the drawn hiragana; read ${JSON.stringify(desktopOcr)}`,
      );
      console.log(`Desktop OCR passed under the app's CSP: read ${JSON.stringify(desktopOcr)}.`);
    } else console.log('Desktop OCR skipped: run with the browser stages to draw its page.');
    // The new-chapter badge on the taskbar button, through the real IPC: a drawn PNG is
    // taken, anything else refused.
    const badge = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d');
      context.fillStyle = '#e5484d';
      context.fillRect(0, 0, 32, 32);
      const shown = await window.desktop.window.setBadge(3, canvas.toDataURL('image/png'));
      const refused = await window.desktop.window.setBadge(3, 'https://evil.test/badge.png').then(
        () => 'accepted',
        (error) => String(error),
      );
      const cleared = await window.desktop.window.setBadge(0);
      return { shown, refused, cleared };
    });
    assert.equal(badge.shown.success, true, JSON.stringify(badge));
    assert.equal(badge.cleared.success, true, JSON.stringify(badge));
    if (process.platform === 'win32') assert.notEqual(badge.refused, 'accepted');
    console.log('Desktop taskbar badge passed through the real IPC.');
    // A folder of pages dropped on the window: Chromium turns a drop into a file: page
    // load, which the main process takes as a comic to import, then the reader opens it.
    const droppedFolder = path.join(`${temporaryProfile}-drop`, 'Dropped pages');
    await mkdir(droppedFolder, { recursive: true });
    await writeFile(path.join(droppedFolder, '1.png'), localPage);
    await writeFile(path.join(droppedFolder, '2.png'), localPage);
    // A real drop through DevTools: a page navigating to file: itself is refused by
    // Chromium before the app sees it, so only a drop shows the path the app handles.
    await page.goto(`${webUrl}/local`);
    await page.getByRole('link', { name: 'Fixture local comic · 2 pages', exact: true }).waitFor();
    const dropSession = await page.context().newCDPSession(page);
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await dropSession.send('Input.dispatchDragEvent', {
        type,
        x: 200,
        y: 200,
        data: { items: [], files: [droppedFolder], dragOperationsMask: 1 },
      });
    await dropSession.detach();
    await page.waitForURL(
      (url) =>
        /\/local-reader\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(localComicId),
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      () =>
        [...document.images].some(
          (image) => image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0,
        ),
      undefined,
      { polling: 250, timeout: 30_000 },
    );
    const droppedId = page.url().split('/').pop();
    assert.notEqual(droppedId, localComicId);
    await page.evaluate((id) => window.desktop.archives.remove(id), droppedId);
    await rm(`${temporaryProfile}-drop`, { recursive: true, force: true });
    console.log('Desktop local import smoke passed: a dropped folder is imported and opened.');
    // App lock: locking hides the app behind a separate PIN window, the app's own IPC
    // refuses meanwhile, and the right PIN brings it back.
    const lockSet = await page.evaluate(() =>
      window.desktop.lock.set({ newPin: 'smoke-pin', idleMinutes: 0 }),
    );
    assert.equal(lockSet.success, true, JSON.stringify(lockSet));
    const [lockPage] = await Promise.all([
      desktop.contexts()[0].waitForEvent('page', { timeout: 15_000 }),
      page.evaluate(() => window.desktop.lock.lockNow()),
    ]);
    await lockPage.waitForLoadState();
    assert.ok(lockPage.url().startsWith('data:text/html'), lockPage.url());
    await assert.rejects(
      page.evaluate(() => window.desktop.archives.list()),
      /locked/,
      'App IPC must refuse while locked',
    );
    await lockPage.locator('#pin').fill('wrong-pin');
    await lockPage.getByRole('button', { name: 'Unlock' }).click();
    await lockPage.getByText('Wrong PIN or password.').waitFor();
    await lockPage.locator('#pin').fill('smoke-pin');
    await Promise.all([
      lockPage.waitForEvent('close', { timeout: 15_000 }),
      lockPage.getByRole('button', { name: 'Unlock' }).click(),
    ]);
    assert.equal((await page.evaluate(() => window.desktop.lock.getState())).data.locked, false);
    assert.equal(
      (await page.evaluate(() => window.desktop.lock.clear({ currentPin: 'smoke-pin' }))).data
        .enabled,
      false,
    );
    console.log('Desktop app lock smoke passed: lock window, refused IPC and PIN unlock.');
    await page.goto(`${webUrl}/settings`);
    await page.getByRole('button', { name: 'Sync & Storage' }).click();
    await page.getByText('Local library', { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByText('Available offline', { exact: false }).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('tab', { name: 'Sign in' }).click();
    await page.getByLabel('Email').fill('smoke-reader@example.test');
    await page.getByLabel('Password').fill('fixture-password');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    try {
      await page
        .getByText('smoke-reader@example.test', { exact: true })
        .waitFor({ timeout: 8_000 });
    } catch (error) {
      throw new Error(
        `Desktop sign-in did not complete. Body: ${(await page.locator('body').innerText()).slice(0, 1600)}; auth requests: ${apiRequests.filter((request) => request.includes('/auth/'))}`,
        { cause: error },
      );
    }
    assert.ok(
      await page.evaluate(() => Boolean(window.desktop?.auth?.syncCachedSession)),
      'Electron auth bridge must be available after sign-in',
    );
    await page.waitForFunction(async () => {
      try {
        return (await window.desktop.archives.list()).length === 0;
      } catch {
        return false;
      }
    });
    assert.equal(
      await page.evaluate(async (id) => {
        try {
          await window.desktop.archives.page(id, 0);
          return false;
        } catch {
          return true;
        }
      }, localComicId),
      true,
      'An account must not read the anonymous archive',
    );
    await page.goto(`${webUrl}/settings`);
    const syncSettingsTab = page.getByRole('button', { name: 'Sync & Storage' });
    try {
      await syncSettingsTab.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
      const pageState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: document.body.innerText.slice(0, 2000),
        buttons: [...document.querySelectorAll('button')].map((button) => button.innerText.trim()),
      }));
      const screenshotPath = path.join(root, 'apps/desktop/.smoke-settings-debug.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      throw new Error(
        `Sync settings tab did not render: ${JSON.stringify({ pageState, webOutput, desktopOutput, screenshotPath })}`,
        { cause: error },
      );
    }
    await syncSettingsTab.click();
    const deviceSyncToggle = page.getByRole('switch', { name: 'Sync this device' });
    await deviceSyncToggle.waitFor({ timeout: 10_000 });
    assert.equal(await deviceSyncToggle.getAttribute('aria-checked'), 'true');
    await deviceSyncToggle.click();
    assert.equal(await deviceSyncToggle.getAttribute('aria-checked'), 'false');
    assert.equal(await page.getByRole('button', { name: 'Sync paused' }).isDisabled(), true);
    await page.reload();
    await page.getByRole('button', { name: 'Sync & Storage' }).click();
    const persistedSyncToggle = page.getByRole('switch', { name: 'Sync this device' });
    await persistedSyncToggle.waitFor({ timeout: 10_000 });
    assert.equal(await persistedSyncToggle.getAttribute('aria-checked'), 'false');
    await persistedSyncToggle.click();
    assert.equal(await persistedSyncToggle.getAttribute('aria-checked'), 'true');
    await stat(path.join(temporaryProfile, 'local-anonymous.db'));
    const added = await page.evaluate(() =>
      window.desktop.data.invoke('history', 'add', {
        source: 'smoke-source',
        manga_slug: 'smoke-offline-progress',
        title: 'Offline progress fixture',
        pages_read: 2,
      }),
    );
    assert.equal(added.success, true, `Local history write failed: ${added.message}`);
    apiOffline = true;
    const interruptedSync = await page.evaluate(() => window.desktop.data.invoke('sync', 'run'));
    assert.equal(interruptedSync.success, false, 'Sync must report the fixture outage');
    apiOffline = false;
    const recoveredSync = await page.evaluate(() => window.desktop.data.invoke('sync', 'run'));
    assert.equal(recoveredSync.success, true, `Sync retry failed: ${recoveredSync.message}`);
    assert.ok(
      syncPushPayloads.some((payload) =>
        payload.history?.some((row) => row.manga_slug === 'smoke-offline-progress'),
      ),
      'Reconnect must push the offline history write to the fixture API',
    );
    assert.ok(
      syncCookies.some((cookie) => cookie.includes('pm_session=smoke-session')),
      'Desktop sync requests must use the session established by renderer sign-in',
    );

    const accountDatabasePath = (accountId) =>
      path.join(
        temporaryProfile,
        `local-user-${createHash('sha256').update(accountId).digest('hex')}.db`,
      );
    const accountOneCookie = 'pm_session=smoke-session';
    const accountOneFirstPull = syncPullRequests.find((pull) =>
      pull.cookie.includes(accountOneCookie),
    );
    assert.ok(accountOneFirstPull, 'The first account must complete a server pull');
    assert.equal(accountOneFirstPull.since, null, 'A new account starts with a full pull');
    await stat(accountDatabasePath('smoke-account'));

    // The second account must start with an empty local library and an independent pull
    // cursor, then push only its own pending history. Switching back must recover account
    // one's local history and its existing cursor without exposing account two's row.
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('tab', { name: 'Sign in' }).waitFor();
    await page.getByRole('tab', { name: 'Sign in' }).click();
    await page.getByLabel('Email').fill('second-reader@example.test');
    await page.getByLabel('Password').fill('fixture-password');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    await page.getByText('second-reader@example.test', { exact: true }).waitFor();
    const accountTwoBeforeWrite = await page.evaluate(() =>
      window.desktop.data.invoke('history', 'list'),
    );
    assert.equal(accountTwoBeforeWrite.success, true);
    assert.equal(
      accountTwoBeforeWrite.data.length,
      0,
      'Account two must not inherit account one history',
    );
    await stat(accountDatabasePath('second-smoke-account'));
    const accountTwoAdded = await page.evaluate(() =>
      window.desktop.data.invoke('history', 'add', {
        source: 'smoke-source',
        manga_slug: 'second-account-only-progress',
        title: 'Second account only fixture',
        pages_read: 3,
      }),
    );
    assert.equal(accountTwoAdded.success, true);
    const accountTwoSync = await page.evaluate(() => window.desktop.data.invoke('sync', 'run'));
    assert.equal(
      accountTwoSync.success,
      true,
      `Second account sync failed: ${accountTwoSync.message}`,
    );
    const accountTwoCookie = 'pm_session=second-smoke-session';
    assert.ok(
      syncPullRequests.some(
        (pull) => pull.cookie.includes(accountTwoCookie) && pull.since === null,
      ),
      'A second account must start from its own full-pull cursor',
    );
    const accountTwoPush = syncPushRequests.find((push) => push.cookie.includes(accountTwoCookie));
    assert.ok(accountTwoPush, 'The second account must push its own pending changes');
    assert.ok(
      accountTwoPush.payload.history?.some(
        (row) => row.manga_slug === 'second-account-only-progress',
      ),
      'Account two sync must include its local history row',
    );
    assert.ok(
      !accountTwoPush.payload.history?.some((row) => row.manga_slug === 'smoke-offline-progress'),
      'Account two sync must not include account one history',
    );

    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('tab', { name: 'Sign in' }).waitFor();
    await page.getByRole('tab', { name: 'Sign in' }).click();
    await page.getByLabel('Email').fill('smoke-reader@example.test');
    await page.getByLabel('Password').fill('fixture-password');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    await page.getByText('smoke-reader@example.test', { exact: true }).waitFor();
    const accountOneHistory = await page.evaluate(() =>
      window.desktop.data.invoke('history', 'list'),
    );
    assert.equal(accountOneHistory.success, true);
    assert.ok(accountOneHistory.data.some((row) => row.manga_slug === 'smoke-offline-progress'));
    assert.ok(
      !accountOneHistory.data.some((row) => row.manga_slug === 'second-account-only-progress'),
      'Switching back must not expose account two history',
    );
    const accountOneResumeSync = await page.evaluate(() =>
      window.desktop.data.invoke('sync', 'run'),
    );
    assert.equal(accountOneResumeSync.success, true);
    assert.ok(
      syncPullRequests.some(
        (pull) => pull.cookie.includes(accountOneCookie) && pull.since === fixtureServerTime,
      ),
      'Switching back to account one must resume its saved pull cursor',
    );

    await page.goto(`${webUrl}/settings`);
    await page.getByRole('button', { name: 'Privacy', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Privacy', exact: true }).click();
    await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
      name: 'smoke-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ version: 2, manga: [], library: [], history: [], downloads: [] }),
      ),
    });
    await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor();
    await page.getByText('Read-only estimate from the current server state.').waitFor();
    assert.equal(restorePreviews.length, 1, 'Restore UI must request a server catalog comparison');
    assert.equal(restorePreviews[0].mode, 'merge');
    await page.getByRole('button', { name: 'Replace current data…' }).click();
    await page.getByText('Compared for replace mode.').waitFor();
    assert.equal(
      restorePreviews.length,
      2,
      'Changing restore mode must refresh the server comparison',
    );
    assert.equal(restorePreviews[1].mode, 'replace');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
      name: 'smoke-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ version: 2, manga: [], library: [], history: [], downloads: [] }),
      ),
    });
    await page.getByText('Compared for merge mode.').waitFor();
    fixtureRestoreComplete = true;
    await page.getByRole('button', { name: 'Merge backup', exact: true }).click();
    await page.waitForFunction(
      () => localStorage.getItem('projekt-manga-pending-restore') !== null,
      { timeout: 10_000 },
    );
    await page.getByRole('status', { name: 'Restoring your library' }).waitFor();
    fixtureRestoreComplete = true;
    await page.waitForFunction(
      () => localStorage.getItem('projekt-manga-pending-restore') === null,
      { timeout: 15_000 },
    );
    assert.equal(restoreJobs.size, 1, 'Restore UI must submit one durable restore job');
    assert.ok(
      apiRequests.some((request) => request.startsWith('/api/restore/jobs/')),
      'Restore UI must poll the durable job until it succeeds',
    );
    apiOffline = true;
    const history = await page.evaluate(() => window.desktop.data.invoke('history', 'list'));
    assert.equal(history.success, true);
    assert.ok(history.data.some((row) => row.manga_slug === 'smoke-offline-progress'));
    apiOffline = false;
    fixtureSyncRevoked = true;
    const failedRevokedSync = await page.evaluate(() => window.desktop.data.invoke('sync', 'run'));
    assert.equal(failedRevokedSync.success, false, 'A revoked session must fail its current sync');
    const requestsAfterRevocation = syncCookies.length;
    await page.waitForTimeout(100);
    const clearedRevokedSync = await page.evaluate(() => window.desktop.data.invoke('sync', 'run'));
    assert.equal(clearedRevokedSync.success, true, JSON.stringify(clearedRevokedSync));
    assert.equal(
      clearedRevokedSync.data,
      null,
      'A revoked session must be cleared from desktop cache',
    );
    assert.equal(
      syncCookies.length,
      requestsAfterRevocation,
      'A cleared revoked session must not be sent again',
    );
    fixtureSyncRevoked = false;
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('tab', { name: 'Sign in' }).waitFor();
    const requestsBeforeSignedOutSync = syncCookies.length;
    const signedOutSync = await page.evaluate(() => window.desktop.data.invoke('sync', 'run'));
    assert.equal(signedOutSync.success, true, 'Sync without a cached account is a no-op');
    assert.equal(signedOutSync.data, null);
    assert.equal(
      syncCookies.length,
      requestsBeforeSignedOutSync,
      'Logout must clear the encrypted session so later sync sends no account request',
    );
    await page.waitForFunction(async () => {
      try {
        return (await window.desktop.archives.list()).length === 1;
      } catch {
        return false;
      }
    });
    assert.equal(
      await page.evaluate((id) => window.desktop.archives.remove(id), localComicId),
      true,
    );
    assert.equal((await page.evaluate(() => window.desktop.archives.list())).length, 0);
    console.log(
      'Desktop smoke passed: account switching with isolated history and cursors, offline progress/reconnect sync, restore job, and offline history read.',
    );
  }
} finally {
  await desktop?.close();
  if (desktopProcess && desktopProcess.exitCode === null && desktopProcess.signalCode === null) {
    desktopProcess.kill();
    await Promise.race([
      new Promise((resolve) => desktopProcess.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  await browser?.close();
  if (web) web.kill();
  if (api.listening) await close(api);
  if (temporaryProfile && temporaryProfile.startsWith(path.join(tmpdir(), 'projekt-manga-smoke-')))
    await rm(temporaryProfile, { recursive: true, force: true });
}
