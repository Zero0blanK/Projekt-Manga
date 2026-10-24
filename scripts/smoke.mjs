import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
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
let searchAttempts = 0;
let browseRequests = [];
let browseSearchRequests = [];
let apiOffline = false;
let fixtureSyncRevoked = false;
let fixtureRestoreConflict = false;
let fixtureRestoreComplete = false;
let fixtureLargeLibrary = true;
const syncPushPayloads = [];
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
  if (url.pathname === '/api/downloads/directory') data = { path: '' };
  if (url.pathname === '/api/manga') data = fixtureLargeLibrary ? libraryTitles : [];
  if (url.pathname === '/api/library') data = [];
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
            chapterIdentityConflicts: fixtureRestoreConflict ? 1 : 0,
            chapterIdentityConflictExamples: fixtureRestoreConflict
              ? ['Fixture title (chapter 1)']
              : [],
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
  if (
    url.pathname.startsWith(`/api/source/${source.id}/chapter/smoke-chapter-`) &&
    url.pathname.endsWith('/pages')
  ) {
    data = {
      items: [1, 2].map((index) => ({
        index,
        image_url: `https://example.invalid/page-${index}.jpg`,
      })),
      pagination: { limit: 100, offset: 0, total: 2 },
    };
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
    await page.getByRole('alertdialog', { name: 'Restoring your library' }).waitFor();
    const secondBrowserWindow = await browserContext.newPage();
    await secondBrowserWindow.goto(`${webUrl}/settings`);
    await secondBrowserWindow
      .getByRole('alertdialog', { name: 'Restoring your library' })
      .waitFor();
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
      'Browser smoke passed: source search, paging, cross-window restore blocking, retry, and mobile nav.',
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
    await page.goto(`${webUrl}/reader/smoke-1?ch=0`);
    await page.locator('img[alt*="page"]').first().waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to Chapter 0.5' }).click();
    await page.waitForURL(/ch=0\.5&page=1&chapterId=smoke-chapter-0\.5/);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Chapter 0', exact: true }).click();
    await page.waitForURL(/ch=0&page=\d+&chapterId=smoke-chapter-0$/);
    console.log('Browser reader chapter-zero and decimal navigation passed.');
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
    await page.waitForFunction(() =>
      [...document.images].some(
        (image) => image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0,
      ),
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
    fixtureRestoreConflict = true;
    await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
      name: 'smoke-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ version: 2, manga: [], library: [], history: [], downloads: [] }),
      ),
    });
    await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor();
    await page.getByRole('alert').getByText('Restore is blocked because chapter IDs').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Merge backup' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Replace current data…' }).click();
    await page.getByRole('button', { name: 'Confirm replace' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm replace' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(
      () => document.activeElement?.textContent?.trim() === 'Choose export',
    );
    fixtureRestoreConflict = false;
    await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
      name: 'smoke-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ version: 2, manga: [], library: [], history: [], downloads: [] }),
      ),
    });
    await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor();
    await page.getByText('Read-only estimate from the current server state.').waitFor();
    assert.equal(restorePreviews.length, 3, 'Restore UI must request a server catalog comparison');
    assert.equal(restorePreviews[2].mode, 'merge');
    await page.getByRole('button', { name: 'Replace current data…' }).click();
    await page.getByText('Compared for replace mode.').waitFor();
    assert.equal(
      restorePreviews.length,
      4,
      'Changing restore mode must refresh the server comparison',
    );
    assert.equal(restorePreviews[3].mode, 'replace');
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
    await page.getByRole('alertdialog', { name: 'Restoring your library' }).waitFor();
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
