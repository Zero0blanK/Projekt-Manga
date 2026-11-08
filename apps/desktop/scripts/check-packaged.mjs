/**
 * Offline checks and measurements against the packaged app (release/win-unpacked).
 *
 *   node scripts/check-packaged.mjs                 run the checks
 *   node scripts/check-packaged.mjs --measure       also print sizes and API start times
 *   node scripts/check-packaged.mjs --resources <dir>
 *
 * Nothing here touches the network or the user's library. Every database is a new file in
 * a temporary folder, the fake source returns fixed data, the repository it is "installed
 * from" is an address the SSRF guard refuses before any request is made, and the browser
 * used for text recognition refuses every request that is not to the local web server.
 *
 * Checks:
 *   - the packaged API starts on an empty database and applies every migration;
 *   - a source runs in the packaged extension sandbox and answers through the API;
 *   - the packaged web server serves its pages, static chunks and OCR files;
 *   - text recognition runs on one image using only the OCR files the web server serves;
 *   - with --migrations <dir>: each *.db in that folder (old schemas) is copied and the
 *     packaged API migrates the copy.
 *
 * Run from apps/desktop after `npm run package` or `npm run package:fast`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..', '..');

const { values } = parseArgs({
  options: {
    resources: { type: 'string' },
    measure: { type: 'boolean', default: false },
    migrations: { type: 'string' },
    'warm-runs': { type: 'string', default: '3' },
  },
});

const RESOURCES = path.resolve(
  values.resources ?? path.join(DESKTOP, 'release', 'win-unpacked', 'resources'),
);
const APP_DIR = path.dirname(RESOURCES);
const NODE_BINARY = path.join(
  RESOURCES,
  'node',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-packaged-check-'));

for (const required of [RESOURCES, NODE_BINARY]) {
  if (!fs.existsSync(required)) throw new Error(`[check] not found: ${required}`);
}

// ----------------------------------------------------------------- helpers ---------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function tree(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The API's entry, wherever this build puts it. */
function apiEntry(resources) {
  for (const candidate of ['server/dist/server.mjs', 'server/dist/server.js']) {
    const full = path.join(resources, ...candidate.split('/'));
    if (fs.existsSync(full)) return full;
  }
  throw new Error(`[check] no API entry under ${resources}/server/dist`);
}

/**
 * Starts the packaged API the way the desktop supervisor does (servers.ts) and resolves
 * once its port accepts connections, with how long that took.
 */
async function startApi(resources, databaseFile, { bundlesDir, label = 'api' } = {}) {
  const port = await freePort();
  const entry = apiEntry(resources);
  const node = path.join(resources, 'node', path.basename(NODE_BINARY));
  const log = [];
  const startedAt = performance.now();
  const child = spawn(node, [entry], {
    cwd: path.dirname(path.dirname(entry)),
    env: {
      ...process.env,
      SERVER_PORT: String(port),
      SERVER_HOST: '127.0.0.1',
      NODE_ENV: 'production',
      DATABASE_URL: `file:${databaseFile}`,
      EXTENSION_BUNDLES_DIR: bundlesDir ?? path.join(path.dirname(databaseFile), 'bundles'),
      PROJEKT_MANGA_AUTO_MIGRATE: '1',
      // The supervisor generates one; any fixed 32-byte key does for a throwaway database.
      TOKEN_ENCRYPTION_KEY: crypto.createHash('sha256').update('packaged-check').digest('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => log.push(data.toString()));
  child.stderr.on('data', (data) => log.push(data.toString()));
  let exited = null;
  child.on('exit', (code) => (exited = code));

  const deadline = Date.now() + 120_000;
  while (!(await portOpen(port))) {
    if (exited !== null) {
      throw new Error(
        `[check] ${label} exited (code ${exited}) before listening:\n${log.join('')}`,
      );
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`[check] ${label} did not listen within 120s:\n${log.join('')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const listenMs = Math.round(performance.now() - startedAt);
  // The "Ready" line comes from the same callback that follows listen; give it a moment.
  for (let i = 0; i < 40 && !/\[server\] Ready/.test(log.join('')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const ready = /\[server\] Ready (\d+)ms after launch \(([^)]*)\)/.exec(log.join(''));
  return {
    port,
    listenMs,
    readyLine: ready ? `${ready[1]}ms (${ready[2]})` : null,
    log,
    stop: () =>
      new Promise((resolve) => {
        if (exited !== null) return resolve();
        child.once('exit', resolve);
        child.kill();
      }),
  };
}

async function getJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    `${pathname} answered ${response.status}: ${text.slice(0, 300)}`,
  );
  return JSON.parse(text);
}

/** Copies an existing database with its WAL sidecars, if any. */
function copyDatabase(from, to) {
  fs.copyFileSync(from, to);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(from + suffix)) fs.copyFileSync(from + suffix, to + suffix);
  }
}

function appliedMigrations(databaseFile) {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
      .all()
      .map((row) => row.migration_name);
  } finally {
    db.close();
  }
}

const shippedMigrations = fs
  .readdirSync(path.join(RESOURCES, 'server', 'prisma', 'migrations'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const results = [];
const pass = (name, detail = '') => {
  results.push(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`[check] PASS ${name}${detail ? ` — ${detail}` : ''}`);
};

// ------------------------------------------------- 1. API on an empty database ------
const primedDb = path.join(WORK, 'primed.db');
{
  const api = await startApi(RESOURCES, primedDb, { label: 'API (empty database)' });
  let health;
  try {
    health = await getJson(api.port, '/api/health');
    // openapi.yaml is found by path, and swagger-ui's assets are served from its own folder.
    const spec = await getJson(api.port, '/api/docs/openapi.json');
    assert.ok(spec.openapi || spec.swagger, 'the API docs route did not serve the spec');
    for (const asset of ['/api/docs/', '/api/docs/swagger-ui.css']) {
      const response = await fetch(`http://127.0.0.1:${api.port}${asset}`);
      assert.equal(response.status, 200, `${asset} answered ${response.status}`);
      await response.arrayBuffer();
    }
    // Read-only routes across every area, so each middleware chain and the packages behind
    // it run once. A 4xx is fine (no account, nothing to find); a 500 means something the
    // packaged API loads is broken, as a bad bundle once made every request fail.
    for (const route of [
      '/api/auth/me',
      '/api/category',
      '/api/category/state',
      '/api/chapter/recent',
      '/api/downloads',
      '/api/downloads/stats',
      '/api/extensions/repositories',
      '/api/extensions/installed',
      '/api/health/ready',
      '/api/health/runtime',
      '/api/health/scraper',
      '/api/history',
      '/api/library/release-estimates',
      '/api/manga/links/all',
      '/api/notification-channels',
      '/api/source/sources',
      '/api/source/capabilities',
      '/api/source/library/check-updates',
      '/api/source-network',
      '/api/sync/generation',
      '/api/trackers/available',
      '/api/update-log',
    ]) {
      const response = await fetch(`http://127.0.0.1:${api.port}${route}`);
      const body = await response.text();
      assert.ok(
        response.status < 500,
        `${route} answered ${response.status}: ${body.slice(0, 200)}`,
      );
    }
  } catch (error) {
    console.error(api.log.join(''));
    throw error;
  } finally {
    await api.stop();
  }
  assert.deepEqual(appliedMigrations(primedDb), shippedMigrations);
  pass(
    'API starts on an empty database',
    `${shippedMigrations.length} migrations applied, health ${JSON.stringify(health).slice(0, 60)}, ready ${api.readyLine}`,
  );
}

// ------------------------------------------- 1b. stack traces name source files -----
// A bundled API (scripts/bundle-server.mjs) logs positions in dist/app.mjs unless its source
// map is shipped and turned on. Resolve a known line of the bundle through the shipped map.
if (fs.existsSync(path.join(RESOURCES, 'server', 'dist', 'app.mjs'))) {
  const dist = path.join(RESOURCES, 'server', 'dist');
  const loader = fs.readFileSync(path.join(dist, 'server.js'), 'utf-8');
  assert.match(
    loader,
    /process\.setSourceMapsEnabled\(true\)/,
    'the API loader does not enable source maps',
  );
  const bundled = fs.readFileSync(path.join(dist, 'app.mjs'), 'utf-8');
  assert.match(
    bundled,
    /\/\/# sourceMappingURL=app\.mjs\.map\s*$/,
    'app.mjs does not link its source map',
  );
  const { SourceMap } = await import('node:module');
  const map = new SourceMap(JSON.parse(fs.readFileSync(path.join(dist, 'app.mjs.map'), 'utf-8')));
  const at = bundled.indexOf('after launch (');
  assert.ok(at > 0, 'could not find the start-up timing line in app.mjs');
  const before = bundled.slice(0, at).split('\n');
  const entry = map.findEntry(before.length - 1, before.at(-1).length);
  assert.match(
    String(entry.originalSource),
    /^projekt-manga:\/\/\/apps\/server\/src\/server\.ts$/,
    `app.mjs maps to ${entry.originalSource}`,
  );
  pass(
    'API stack traces map to source files',
    `${path.basename(entry.originalSource)}:${entry.originalLine + 1}`,
  );
}

// ------------------------------------------------- 2. a source in the sandbox -------
{
  const dir = path.join(WORK, 'sandbox');
  fs.mkdirSync(dir);
  const db = path.join(dir, 'library.db');
  copyDatabase(primedDb, db);
  const bundlesDir = path.join(dir, 'bundles');
  const bundle = [
    "const rows = ['one', 'two', 'three'].map((id) => ({",
    '  id: `offline-${id}`, slug: `offline-${id}`, title: `Offline ${id}`,',
    "  source: 'offline-check', thumbnail_url: '',",
    '}));',
    'export default {',
    "  id: 'offline-check',",
    '  async fetchManga(_category, { offset = 0, limit = 20 } = {}) {',
    '    return rows.slice(offset, offset + limit);',
    '  },',
    '  async searchManga(_query, pagination) { return this.fetchManga(undefined, pagination); },',
    "  async getFilters() { return [{ type: 'select', label: 'Status', value: 'status', options: [{ label: 'Any', value: '' }] }]; },",
    '};',
    '',
  ].join('\n');
  const repositoryId = 'offlinecheckrepo';
  const extensionId = 'offlinecheckext';
  fs.mkdirSync(path.join(bundlesDir, extensionId), { recursive: true });
  fs.writeFileSync(path.join(bundlesDir, extensionId, 'bundle.js'), bundle);
  const sqlite = new DatabaseSync(db);
  // 127.0.0.1:1 is refused by the server's SSRF guard before any request is made, so a
  // background update check of this repository never reaches the network.
  sqlite
    .prepare('INSERT INTO extension_repositories (id, url, enabled) VALUES (?, ?, 1)')
    .run(repositoryId, 'http://127.0.0.1:1/index.json');
  sqlite
    .prepare(
      `INSERT INTO installed_extensions
        (id, repository_id, source_key, name, lang, base_url, is_nsfw, allowed_hosts, version,
         entry_url, source_code_hash, updated_at, enabled)
       VALUES (?, ?, 'offline-check', 'Offline check', 'en', 'https://offline.invalid', 0, '[]',
         '1.0.0', 'http://127.0.0.1:1/bundle.js', ?, CURRENT_TIMESTAMP, 1)`,
    )
    .run(extensionId, repositoryId, crypto.createHash('sha256').update(bundle).digest('hex'));
  sqlite.close();

  const api = await startApi(RESOURCES, db, { bundlesDir, label: 'API (sandbox)' });
  try {
    const manga = await getJson(api.port, '/api/source/offline-check/manga?limit=2');
    const titles = JSON.stringify(manga);
    assert.match(titles, /Offline one/, `unexpected source answer: ${titles.slice(0, 300)}`);
    assert.match(titles, /Offline two/);
    assert.doesNotMatch(titles, /Offline three/, 'the limit was not passed to the sandbox');
    const filters = JSON.stringify(await getJson(api.port, '/api/source/offline-check/filters'));
    assert.match(filters, /status/);
    pass('a source runs in the packaged sandbox', 'list and filters answered through the API');
  } catch (error) {
    console.error(api.log.join(''));
    throw error;
  } finally {
    await api.stop();
  }
}

// ------------------------------------------- 3. web server and text recognition -----
{
  const port = await freePort();
  // Next's standalone output keeps the monorepo's shape (stage-installer.mjs); builds
  // before it shipped `.next` with a full node_modules and ran `next start`.
  const standaloneDir = path.join(RESOURCES, 'web', 'apps', 'web');
  const standalone = fs.existsSync(path.join(standaloneDir, 'server.js'));
  const args = standalone
    ? [path.join(standaloneDir, 'server.js')]
    : [
        path.join(RESOURCES, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ];
  const log = [];
  const web = spawn(NODE_BINARY, args, {
    cwd: standalone ? standaloneDir : path.join(RESOURCES, 'web'),
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      // Nothing listens there; pages that need the API render their offline state.
      PROJEKT_MANGA_API_PORT: '1',
      NEXT_PUBLIC_API_URL: '/api',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stdout.on('data', (data) => log.push(data.toString()));
  web.stderr.on('data', (data) => log.push(data.toString()));
  const startedAt = Date.now();
  while (!(await portOpen(port))) {
    if (web.exitCode !== null || Date.now() - startedAt > 60_000) {
      web.kill();
      throw new Error(`[check] web server did not start:\n${log.join('')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const origin = `http://127.0.0.1:${port}`;
  try {
    // Pages and the static chunks they reference.
    for (const page of ['/', '/discover', '/settings', '/reader/x/y']) {
      const response = await fetch(origin + page);
      assert.ok(response.status < 500, `${page} answered ${response.status}`);
      const html = await response.text();
      const chunks = [...html.matchAll(/\/_next\/static\/[^"'\s)]+\.(?:js|css)/g)].map((m) => m[0]);
      assert.ok(chunks.length > 0, `${page} references no static chunks`);
      for (const chunk of new Set(chunks)) {
        const asset = await fetch(origin + chunk);
        assert.equal(asset.status, 200, `${chunk} (from ${page}) answered ${asset.status}`);
        await asset.arrayBuffer();
      }
    }
    for (const file of ['/brand/ProjektManga.icon.png', '/ocr/worker.min.js']) {
      const response = await fetch(origin + file);
      assert.equal(response.status, 200, `${file} answered ${response.status}`);
      await response.arrayBuffer();
    }
    pass('the packaged web server serves pages, static chunks and public files');

    const requireFromExtensions = createRequire(path.join(ROOT, 'apps/extensions/package.json'));
    const { chromium } = requireFromExtensions('playwright');
    const tesseractScript = fs.readFileSync(
      createRequire(path.join(ROOT, 'apps/web/package.json')).resolve(
        'tesseract.js/dist/tesseract.min.js',
      ),
      'utf-8',
    );
    // Playwright's own Chromium when it is installed (CI installs it); otherwise the Edge
    // every Windows machine has, so a local run needs no browser download.
    const browser = await chromium
      .launch()
      .catch(() =>
        chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome' }),
      );
    try {
      const context = await browser.newContext({ bypassCSP: true });
      const blocked = [];
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        blocked.push(url.href);
        return route.abort();
      });
      const page = await context.newPage();
      // A blank same-origin page, so the worker and its files load exactly as the app's do.
      await page.route(`${origin}/__ocr-check`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>ocr</title>' }),
      );
      await page.goto(`${origin}/__ocr-check`);
      await page.addScriptTag({ content: tesseractScript });
      const text = await page.evaluate(async () => {
        // One column of vertical Japanese, as a speech bubble would hold it.
        const glyphs = '日本語の本';
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size * 3;
        canvas.height = size * (glyphs.length + 2);
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#000';
        context.font = `${size}px "Yu Gothic", "MS Gothic", "Noto Sans CJK JP", sans-serif`;
        context.textBaseline = 'top';
        [...glyphs].forEach((glyph, index) => context.fillText(glyph, size, size * (index + 1)));
        const at = (p) => new URL(p, window.location.origin).href;
        const { createWorker, OEM, PSM } = window.Tesseract;
        const worker = await createWorker('jpn_vert', OEM.LSTM_ONLY, {
          workerPath: at('/ocr/worker.min.js'),
          corePath: at('/ocr/core'),
          langPath: at('/ocr/lang'),
          workerBlobURL: false,
          gzip: true,
        });
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK_VERT_TEXT });
        const { data } = await worker.recognize(canvas);
        await worker.terminate();
        return data.text;
      });
      const recognised = [...'日本語の本'].filter((glyph) => text.includes(glyph)).length;
      assert.ok(recognised >= 3, `text recognition read ${JSON.stringify(text)}`);
      assert.deepEqual(blocked, [], 'the OCR check tried to reach another host');
      pass('text recognition runs on the served OCR files', `read ${JSON.stringify(text.trim())}`);
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error(log.join(''));
    throw error;
  } finally {
    web.kill();
  }
}

// --------------------------------------------- 4. migrating old databases ------------
if (values.migrations) {
  const fixtures = fs
    .readdirSync(values.migrations)
    .filter((name) => name.endsWith('.db'))
    .sort();
  assert.ok(fixtures.length > 0, `no .db files in ${values.migrations}`);
  for (const name of fixtures) {
    const dir = path.join(WORK, `migrate-${path.basename(name, '.db')}`);
    fs.mkdirSync(dir);
    const db = path.join(dir, 'library.db');
    copyDatabase(path.join(values.migrations, name), db);
    const before = appliedMigrations(db).length;
    const api = await startApi(RESOURCES, db, { label: `API (${name})` });
    try {
      await getJson(api.port, '/api/health');
      // Reads that touch the migrated tables, as the library screen does on launch.
      await getJson(api.port, '/api/library');
      await getJson(api.port, '/api/manga?limit=5');
      await getJson(api.port, '/api/category');
    } catch (error) {
      console.error(api.log.join(''));
      throw error;
    } finally {
      await api.stop();
    }
    assert.deepEqual(appliedMigrations(db), shippedMigrations, `${name} is not fully migrated`);
    const backups = fs.readdirSync(dir).filter((file) => file.endsWith('.bak'));
    if (before < shippedMigrations.length) {
      assert.equal(
        backups.length,
        1,
        `${name}: expected one pre-migration backup, found ${backups}`,
      );
    }
    // The library seeded by make-migration-fixtures.mjs comes through intact.
    const sqlite = new DatabaseSync(db, { readOnly: true });
    try {
      const count = (sql) => Number(Object.values(sqlite.prepare(sql).get())[0]);
      assert.equal(count('SELECT COUNT(*) FROM mangas'), 3, `${name}: titles lost`);
      assert.equal(count('SELECT COUNT(*) FROM chapters'), 12, `${name}: chapters lost`);
      assert.equal(
        count('SELECT COUNT(*) FROM chapters WHERE is_read = 1'),
        6,
        `${name}: read state lost`,
      );
      assert.equal(count('SELECT COUNT(*) FROM histories'), 3, `${name}: history lost`);
      assert.equal(Object.values(sqlite.prepare('PRAGMA integrity_check').get())[0], 'ok');
    } finally {
      sqlite.close();
    }
    pass(
      `migrates a ${name} database`,
      `${before} -> ${shippedMigrations.length} migrations${backups.length ? `, backup ${backups.join(', ')}` : ''}`,
    );
  }
}

// ---------------------------------------------------------- measurements ------------
if (values.measure) {
  const app = tree(APP_DIR);
  const parts = Object.fromEntries(
    ['server', 'web', 'node', 'extensions']
      .filter((name) => fs.existsSync(path.join(RESOURCES, name)))
      .map((name) => [name, tree(path.join(RESOURCES, name))]),
  );
  const installer = fs
    .readdirSync(path.join(DESKTOP, 'release'))
    .filter((name) => /^Projekt-Manga-Setup-.*\.exe$/.test(name))
    .map((name) => ({ name, bytes: fs.statSync(path.join(DESKTOP, 'release', name)).size }))[0];

  // Cold: freshly written files, as after an update, which antivirus scans on first read.
  // Warm: the same files again. Both use an already-migrated database, as an update would.
  const coldResources = path.join(WORK, 'cold', 'resources');
  for (const name of ['server', 'node', 'extensions']) {
    if (fs.existsSync(path.join(RESOURCES, name))) {
      fs.cpSync(path.join(RESOURCES, name), path.join(coldResources, name), { recursive: true });
    }
  }
  const timings = [];
  const runs = 1 + Number(values['warm-runs']);
  for (let run = 0; run < runs; run++) {
    const db = path.join(WORK, `timing-${run}.db`);
    copyDatabase(primedDb, db);
    const api = await startApi(coldResources, db, { label: `API timing run ${run}` });
    await api.stop();
    timings.push(api);
  }
  const warm = timings
    .slice(1)
    .map((t) => t.listenMs)
    .sort((a, b) => a - b);
  console.log('\n[measure] packaged app');
  console.log(`  app folder:     ${app.files} files, ${mb(app.bytes)}`);
  for (const [name, part] of Object.entries(parts)) {
    console.log(`  resources/${name.padEnd(10)} ${part.files} files, ${mb(part.bytes)}`);
  }
  if (installer) console.log(`  installer:      ${installer.name}, ${mb(installer.bytes)}`);
  console.log(`  API cold start: ${timings[0].listenMs} ms to listen; ${timings[0].readyLine}`);
  console.log(
    `  API warm start: median ${warm[Math.floor(warm.length / 2)]} ms to listen (${warm.join(', ')}); last ${timings.at(-1).readyLine}`,
  );
}

console.log(`\n[check] ${results.length} checks passed`);
fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
