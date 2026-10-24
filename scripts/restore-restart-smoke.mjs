import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = path.join(root, 'apps', 'server');
const desktopRoot = path.join(root, 'apps', 'desktop');
const serverEntry = path.join(serverRoot, 'dist', 'server.js');
const migrations = path.join(serverRoot, 'prisma', 'migrations');
const tempRoot = path.join(serverRoot, '.restore-restart-smoke-');
const webRoot = path.join(root, 'apps', 'web');
const requireFromExtensions = createRequire(path.join(root, 'apps', 'extensions', 'package.json'));
const requireFromWeb = createRequire(path.join(root, 'apps', 'web', 'package.json'));
const { chromium } = requireFromExtensions('playwright');
const electronExecutable = requireFromExtensions('electron');
const nextCli = requireFromWeb.resolve('next/dist/bin/next');
const { RESTORE_UPLOAD_LIMIT_BYTES } = requireFromWeb('@projekt-manga/schemas');
const childEnvironment = {
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
  ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
  NODE_ENV: 'test',
  SERVER_HOST: '127.0.0.1',
  CLIENT_URL: 'http://127.0.0.1:3000',
  PROJEKT_MANGA_AUTO_MIGRATE: '1',
  EXTENSION_REPOSITORY_TRUST_KEYS: '{}',
};

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function startServer(cwd, port, databaseUrl) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: { ...childEnvironment, SERVER_PORT: String(port), DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-8000);
    });
  }
  return { child, exited, getOutput: () => output };
}

function startWeb(cwd, port, apiPort) {
  const child = spawn(
    process.execPath,
    [nextCli, 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
        NODE_ENV: 'development',
        NEXT_PUBLIC_API_URL: '/api',
        PROJEKT_MANGA_API_PORT: String(apiPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-8000);
    });
  }
  return { child, exited, getOutput: () => output };
}

function startElectron(userData, webUrl, apiUrl, debugPort) {
  const child = spawn(
    electronExecutable,
    [
      '--disable-gpu',
      `--remote-debugging-port=${debugPort}`,
      path.join(desktopRoot, 'scripts', 'smoke-entry.cjs'),
    ],
    {
      cwd: desktopRoot,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
        NODE_ENV: 'development',
        PROJEKT_MANGA_SMOKE_USER_DATA: userData,
        PROJEKT_MANGA_WEB_URL: webUrl,
        PROJEKT_MANGA_API_URL: apiUrl,
        PROJEKT_MANGA_MANAGED_SERVERS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-8000);
    });
  }
  return { child, exited, getOutput: () => output, debugUrl: `http://127.0.0.1:${debugPort}` };
}

async function waitForHealth(server, url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `Server exited ${server.child.exitCode} before becoming ready:\n${server.getOutput()}`,
      );
    }
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Startup migrations and worker recovery run before the server binds its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready:\n${server.getOutput()}`);
}

async function waitForWeb(server, url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Web server exited ${server.child.exitCode}:\n${server.getOutput()}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The production server may still be initializing its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Web server did not become ready:\n${server.getOutput()}`);
}

async function connectElectron(server, webUrl) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Electron exited ${server.child.exitCode}:\n${server.getOutput()}`);
    }
    try {
      const targetsResponse = await fetch(`${server.debugUrl}/json/list`);
      if (targetsResponse.ok) {
        const targets = await targetsResponse.json();
        if (!targets.some((target) => target.type === 'page' && target.url.startsWith(webUrl))) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        const browser = await chromium.connectOverCDP(server.debugUrl);
        const context = browser.contexts()[0];
        let page = context.pages().find((candidate) => candidate.url().startsWith(webUrl));
        if (!page) {
          await browser.close();
          continue;
        }
        // Let Electron's initial loadURL finish before navigating; interrupting it
        // schedules the window's startup retry and can replace the restore dialog.
        await page.waitForLoadState('load');
        await page.waitForFunction(() => window.desktop?.data?.invoke, { timeout: 30_000 });
        return { browser, page };
      }
    } catch {
      // Electron's remote debugging endpoint and window can start at different times.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Electron did not load its isolated renderer:\n${server.getOutput()}`);
}

async function submitRestoreFromPrivacy(page, prefix, webUrl) {
  const titleSlug = `${prefix}-restart-title`;
  const mangaId = `${prefix}-restart-manga`;
  const chapterId = `${prefix}-restart-chapter`;
  await page.goto(`${webUrl}/settings#privacy`);
  await page.getByRole('button', { name: 'Choose export', exact: true }).waitFor();
  await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
    name: `${prefix}-restart-smoke-backup.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 2,
        manga: [
          {
            id: mangaId,
            source: 'restore-restart-smoke',
            slug: titleSlug,
            title: `${prefix} restore restart smoke fixture`,
            author: 'Fixture Author',
            thumbnail_url: 'https://example.invalid/cover.jpg',
            artist: null,
            description: 'Disposable restart acceptance fixture',
            genres: 'Test',
            status: 'ONGOING',
            rating: null,
            chapters: [
              {
                id: chapterId,
                url: 'https://example.invalid/chapter/1',
                name: 'Chapter 1',
                scanlator: null,
                chapter_number: 1,
                last_page_read: 0,
                is_read: false,
                is_bookmark: false,
                release_date: null,
                page_count: 12,
              },
            ],
          },
        ],
        library: [
          {
            manga_id: mangaId,
            is_bookmarked: false,
            shelf_status: 'READING',
            notification_read: false,
          },
        ],
        history: [],
        downloads: [],
      }),
    ),
  });
  await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor();
  await page.getByRole('button', { name: 'Replace current data…' }).click();
  await page.getByRole('button', { name: 'Confirm replace' }).click();
  await page.waitForFunction(() => localStorage.getItem('projekt-manga-pending-restore') !== null, {
    timeout: 10_000,
  });
  const jobId = await page.evaluate(
    () => JSON.parse(localStorage.getItem('projekt-manga-pending-restore') ?? '{}').id,
  );
  assert.equal(typeof jobId, 'string');
  await page.getByRole('alertdialog', { name: 'Restoring your library' }).waitFor();
  return { jobId, titleSlug, chapterId };
}

async function chromiumJsHeapUsed(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const value = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value;
  assert.equal(typeof value, 'number', 'Chromium must report renderer JSHeapUsedSize');
  return value;
}

function persistedRestoreState(workDir, jobId) {
  const db = new DatabaseSync(path.join(workDir, 'restore-restart-smoke.db'), { readOnly: true });
  try {
    return db.prepare('SELECT state FROM restore_jobs WHERE id = ?').get(jobId)?.state;
  } finally {
    db.close();
  }
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = server.exited;
  server.child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    const killed = server.exited;
    server.child.kill('SIGKILL');
    await killed;
  }
}

let workDir;
let firstServer;
let restartedServer;
let webServer;
let browser;
try {
  assert.ok(
    await readFile(serverEntry).then(
      () => true,
      () => false,
    ),
    'Build the server before this smoke test',
  );
  workDir = await mkdtemp(tempRoot);
  const prismaDir = path.join(workDir, 'prisma');
  await mkdir(prismaDir);
  await cp(migrations, path.join(prismaDir, 'migrations'), { recursive: true });
  await cp(path.join(serverRoot, 'prisma', 'schema.prisma'), path.join(prismaDir, 'schema.prisma'));
  // The server's startup migration runner uses process.cwd(). Keep its Prisma project
  // isolated while resolving the installed Prisma CLI through the server build.
  await writeFile(
    path.join(workDir, 'prisma.config.ts'),
    "import 'dotenv/config';\nimport { defineConfig, env } from 'prisma/config';\nexport default defineConfig({ schema: './prisma/schema.prisma', datasource: { url: env('DATABASE_URL') } });\n",
  );

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = 'file:restore-restart-smoke.db';
  firstServer = startServer(workDir, port, databaseUrl);
  await waitForHealth(firstServer, baseUrl);
  const rendererRoot = path.join(workDir, 'web');
  await mkdir(rendererRoot);
  for (const entry of [
    'src',
    'public',
    'package.json',
    'next.config.ts',
    'postcss.config.mjs',
    'tsconfig.json',
    'next-env.d.ts',
  ]) {
    await cp(path.join(webRoot, entry), path.join(rendererRoot, entry), { recursive: true });
  }
  // Reuse installed workspace dependencies without copying or loading web .env files.
  await symlink(
    path.join(webRoot, 'node_modules'),
    path.join(rendererRoot, 'node_modules'),
    'junction',
  );
  const webPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  webServer = startWeb(rendererRoot, webPort, port);
  await waitForWeb(webServer, `${webUrl}/settings`);

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const browserRestore = await submitRestoreFromPrivacy(page, 'browser', webUrl);

  // The renderer persisted its blocker after the real HTTP 202 response. Stop inside the
  // worker's three-second pre-claim window, then prove the blocker survives the outage.
  const queued = await fetch(`${baseUrl}/api/restore/jobs/${browserRestore.jobId}`);
  assert.equal(queued.status, 200);
  assert.equal((await queued.json()).data.state, 'queued');
  await stopServer(firstServer);
  firstServer = undefined;
  assert.ok(
    ['queued', 'running'].includes(persistedRestoreState(workDir, browserRestore.jobId)),
    'The first server must stop before the restore reaches a terminal state',
  );
  await page.getByRole('alertdialog', { name: 'Restoring your library' }).waitFor();

  restartedServer = startServer(workDir, port, databaseUrl);
  await waitForHealth(restartedServer, baseUrl);
  await page
    .getByRole('alertdialog', { name: 'Restoring your library' })
    .waitFor({ state: 'hidden', timeout: 20_000 });
  await page.waitForFunction(() => localStorage.getItem('projekt-manga-pending-restore') === null, {
    timeout: 2_000,
  });

  const finalStatus = await fetch(`${baseUrl}/api/restore/jobs/${browserRestore.jobId}`);
  assert.equal(finalStatus.status, 200);
  const finalJob = (await finalStatus.json()).data;
  assert.equal(finalJob.state, 'succeeded');
  assert.deepEqual(finalJob.result, { restoredManga: 1, restoredProgress: 0, restoredHistory: 0 });

  const db = new DatabaseSync(path.join(workDir, 'restore-restart-smoke.db'), { readOnly: true });
  try {
    const manga = db
      .prepare('SELECT id, in_library FROM mangas WHERE source = ? AND slug = ?')
      .get('restore-restart-smoke', browserRestore.titleSlug);
    const chapter = db
      .prepare('SELECT id, manga_id FROM chapters WHERE id = ?')
      .get(browserRestore.chapterId);
    assert.ok(manga && typeof manga.id === 'string' && manga.in_library === 1);
    assert.ok(chapter && chapter.id === browserRestore.chapterId && chapter.manga_id === manga.id);
  } finally {
    db.close();
  }
  console.info('Browser restore survived the server restart and persisted its imported data.');

  // Repeat through Electron's real preload and isolated profile. It points at the same
  // browser renderer origin, while its preload/local SQLite cache remain separate.
  await stopServer(restartedServer);
  restartedServer = undefined;
  firstServer = startServer(workDir, port, databaseUrl);
  await waitForHealth(firstServer, baseUrl);
  const electronDebugPort = await freePort();
  let electronServer = startElectron(
    path.join(workDir, 'electron-user-data'),
    webUrl,
    `${baseUrl}/api`,
    electronDebugPort,
  );
  let electronConnection;
  try {
    electronConnection = await connectElectron(electronServer, webUrl);
    const electronRestore = await submitRestoreFromPrivacy(
      electronConnection.page,
      'electron',
      webUrl,
    );
    const electronQueued = await fetch(`${baseUrl}/api/restore/jobs/${electronRestore.jobId}`);
    assert.equal(electronQueued.status, 200);
    assert.equal((await electronQueued.json()).data.state, 'queued');

    await stopServer(firstServer);
    firstServer = undefined;
    assert.ok(
      ['queued', 'running'].includes(persistedRestoreState(workDir, electronRestore.jobId)),
      'The Electron server must stop before restore reaches a terminal state',
    );
    await electronConnection.page
      .getByRole('alertdialog', { name: 'Restoring your library' })
      .waitFor();

    restartedServer = startServer(workDir, port, databaseUrl);
    await waitForHealth(restartedServer, baseUrl);
    await electronConnection.page
      .getByRole('alertdialog', { name: 'Restoring your library' })
      .waitFor({ state: 'hidden', timeout: 20_000 });
    await electronConnection.page.waitForFunction(
      () => localStorage.getItem('projekt-manga-pending-restore') === null,
      { timeout: 5_000 },
    );

    const electronFinalStatus = await fetch(`${baseUrl}/api/restore/jobs/${electronRestore.jobId}`);
    assert.equal(electronFinalStatus.status, 200);
    const electronFinalJob = (await electronFinalStatus.json()).data;
    assert.equal(electronFinalJob.state, 'succeeded');
    assert.deepEqual(electronFinalJob.result, {
      restoredManga: 1,
      restoredProgress: 0,
      restoredHistory: 0,
    });
    const verifiedDb = new DatabaseSync(path.join(workDir, 'restore-restart-smoke.db'), {
      readOnly: true,
    });
    try {
      const manga = verifiedDb
        .prepare('SELECT id, in_library FROM mangas WHERE source = ? AND slug = ?')
        .get('restore-restart-smoke', electronRestore.titleSlug);
      const chapter = verifiedDb
        .prepare('SELECT id, manga_id FROM chapters WHERE id = ?')
        .get(electronRestore.chapterId);
      assert.ok(manga && typeof manga.id === 'string' && manga.in_library === 1);
      assert.ok(
        chapter && chapter.id === electronRestore.chapterId && chapter.manga_id === manga.id,
      );
    } finally {
      verifiedDb.close();
    }
  } finally {
    await electronConnection?.browser.close();
    await stopServer(electronServer);
  }
  console.info('Electron restore survived the server restart and persisted its imported data.');

  // Measure Chromium renderer heap while the browser parses and previews a limit-sized
  // backup. This is a sampled JS heap metric, not whole-process memory or a peak guarantee.
  await page.goto(`${webUrl}/settings#privacy`);
  await page.getByRole('button', { name: 'Choose export', exact: true }).waitFor();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const baselineHeapBytes = await chromiumJsHeapUsed(cdp);
  const largeBackup = {
    version: 2,
    manga: [
      {
        id: 'near-limit-manga',
        source: 'restore-restart-smoke',
        slug: 'near-limit-title',
        title: 'Near limit fixture',
        author: 'Fixture Author',
        thumbnail_url: 'https://example.invalid/cover.jpg',
        artist: null,
        description: '',
        genres: 'Test',
        status: 'ONGOING',
        rating: null,
        chapters: [],
      },
    ],
    library: [
      {
        manga_id: 'near-limit-manga',
        is_bookmarked: false,
        shelf_status: 'READING',
        notification_read: false,
      },
    ],
    history: [],
    downloads: [],
  };
  const emptyDescriptionBytes = Buffer.byteLength(JSON.stringify(largeBackup));
  // JSON whitespace reaches the browser file ceiling while leaving room for the
  // preview request's owner/mode metadata after parsing removes that whitespace.
  const previewMetadataBudget = 1024;
  largeBackup.manga[0].description = 'x'.repeat(
    RESTORE_UPLOAD_LIMIT_BYTES - emptyDescriptionBytes - previewMetadataBudget,
  );
  const largeBackupFile = `${JSON.stringify(largeBackup)}${' '.repeat(previewMetadataBudget)}`;
  const largeBackupBytes = Buffer.byteLength(largeBackupFile);
  assert.equal(largeBackupBytes, RESTORE_UPLOAD_LIMIT_BYTES);
  let sampling = true;
  let samplingError;
  let sampledPeakHeapBytes = baselineHeapBytes;
  const sampler = (async () => {
    while (sampling) {
      sampledPeakHeapBytes = Math.max(sampledPeakHeapBytes, await chromiumJsHeapUsed(cdp));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })().catch((error) => {
    samplingError = error;
  });
  let retainedHeapBytes;
  try {
    await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
      name: 'near-limit-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(largeBackupFile),
    });
    await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor({ timeout: 30_000 });
    await page.getByText('Compared for merge mode.').waitFor({ timeout: 30_000 });
    sampling = false;
    await sampler;
    if (samplingError) throw samplingError;
    await cdp.send('HeapProfiler.collectGarbage');
    retainedHeapBytes = await chromiumJsHeapUsed(cdp);
  } finally {
    sampling = false;
    await sampler;
    await cdp.detach();
  }
  console.info(
    `[restore-browser-heap] backup_bytes=${largeBackupBytes} baseline_js_heap_bytes=${Math.round(baselineHeapBytes)} sampled_peak_js_heap_bytes=${Math.round(sampledPeakHeapBytes)} retained_js_heap_bytes=${Math.round(retainedHeapBytes)} retained_delta_bytes=${Math.round(retainedHeapBytes - baselineHeapBytes)}`,
  );
  console.log(
    'Browser and Electron restore restart smoke passed; exact-limit browser import preview heap was measured.',
  );
} finally {
  if (firstServer) await stopServer(firstServer);
  if (restartedServer) await stopServer(restartedServer);
  if (webServer) await stopServer(webServer);
  await browser?.close();
  if (workDir && workDir.startsWith(tempRoot)) await rm(workDir, { recursive: true, force: true });
}
