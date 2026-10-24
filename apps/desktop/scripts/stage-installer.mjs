/**
 * Builds a self-contained staging tree for the installer to package.
 *
 * Why this exists: npm workspaces hoist dependencies to the repo root, so `apps/server` and
 * `apps/web` have almost empty `node_modules` of their own. Pointing electron-builder's
 * `extraResources` straight at them would ship a server missing express and Prisma, and
 * without a `package.json`, so Node would parse the ESM build as CommonJS and fail on the
 * first `import`.
 *
 * So each app is staged into its own directory with its real `package.json`, and
 * production dependencies are installed *there*, outside the workspace, where npm has to
 * materialise a complete tree instead of hoisting.
 *
 * Run from apps/desktop:  node scripts/stage-installer.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stageNodeRuntime } from './stage-node-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..', '..');
const { values } = parseArgs({ options: { 'out-dir': { type: 'string' } } });
const outputName = values['out-dir'];
if (outputName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(outputName)) {
  throw new Error('--out-dir must be a new directory name inside apps/desktop');
}
const STAGING = path.join(DESKTOP, outputName ?? 'staging');
// An explicit output preserves previous artifacts and refuses an existing destination.
if (outputName !== undefined) fs.mkdirSync(STAGING);
/** Outside `staging/`, which is cleared on every run — the download is tens of megabytes
 * and does not change between builds. */
const NODE_CACHE = path.join(DESKTOP, '.node-runtime-cache');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * `shell` only for the `.cmd` shims, which Windows cannot execute directly.
 *
 * Not for everything on win32: running `C:\Program Files\nodejs\node.exe` through the
 * shell splits the path at the space, and the failure surfaces as a bare non-zero exit
 * with no message.
 */
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: command.endsWith('.cmd') });
}

function copyDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/** The version of `name` the workspace actually installed for `appDir`, or null. */
function installedVersion(appDir, name) {
  for (const base of [appDir, ROOT]) {
    const manifest = path.join(base, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf-8')).version;
  }
  return null;
}

/**
 * Rewrites workspace dependencies to nothing.
 *
 * `@projekt-manga/*` packages are `"*"` workspace links that npm cannot resolve from
 * outside the workspace. They are already compiled into each app's `dist`/`.next` output,
 * so the staged copy does not need them as runtime dependencies — leaving them in makes
 * `npm install` fail outright with E404.
 */
function stagePackageJson(appDir, destDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8'));
  for (const field of ['devDependencies', 'scripts']) delete pkg[field];
  // Each dependency is pinned to the exact version the repo resolved. Ranges let the staged
  // install pick newer releases than the app was built and tested with: `^16.3.1` resolved
  // to Next 16.4.1, whose server could not start a 16.3.1 build (missing
  // .next/server/preview-props.json), so the installed app never got past a blank window.
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies ?? {})
      .filter(([name]) => !name.startsWith('@projekt-manga/'))
      .map(([name, range]) => [name, installedVersion(appDir, name) ?? range]),
  );
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify(pkg, null, 2));
  return pkg;
}

/**
 * Windows holds handles on freshly-used files for a moment after the process exits — the
 * Prisma query engine binaries in particular — so deleting a staging tree that was just
 * built throws EPERM. Retrying briefly is the difference between a rebuild that works and
 * one that fails every second run.
 */
function removeWithRetry(target, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
    }
  }
}

/**
 * Rebuilds the apps before staging them.
 *
 * Copying whatever `dist`/`.next` happen to exist could ship a stale build. Building here
 * makes `npm run package` reproducible instead of dependent on what was last run by hand.
 *
 * NEXT_PUBLIC_API_URL is pinned to the relative base on purpose. It is inlined at build
 * time, and the installer's single-origin design (apps/web's `src/proxy.ts`, the
 * runtime API port) depends on the bundle holding "/api" rather than a baked host:port.
 * Building without it produces an installer that looks fine and cannot load a cover.
 */
console.log('[stage] building server, extensions and web');
run(npm, ['run', 'build', '--workspace=@projekt-manga/server'], ROOT);
run(npm, ['run', 'build', '--workspace=@projekt-manga/extensions'], ROOT);
execFileSync(npm, ['run', 'build', '--workspace=ProjektManga'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: npm.endsWith('.cmd'),
  env: { ...process.env, NEXT_PUBLIC_API_URL: '/api' },
});

if (outputName === undefined) {
  console.log('[stage] clearing', STAGING);
  removeWithRetry(STAGING);
}

// ----------------------------------------------------------------- server ----------
const serverSrc = path.join(ROOT, 'apps', 'server');
const serverOut = path.join(STAGING, 'server');
console.log('[stage] server: package.json + dist + prisma');
stagePackageJson(serverSrc, serverOut);
copyDir(path.join(serverSrc, 'dist'), path.join(serverOut, 'dist'));
copyDir(path.join(serverSrc, 'prisma'), path.join(serverOut, 'prisma'));
// Served by routes/docs.route.ts, which logs an ENOENT at startup without it.
const openapi = path.join(serverSrc, 'openapi.yaml');
if (fs.existsSync(openapi)) fs.copyFileSync(openapi, path.join(serverOut, 'openapi.yaml'));
/**
 * A JavaScript Prisma config, written rather than copied.
 *
 * The repo's own prisma.config.ts cannot be used here: it is TypeScript, and the staged
 * tree has no tsx to load it. Prisma 7 has no `--url` flag either — `migrate deploy` reads
 * the datasource URL *only* from a config file, so without this the packaged app fails
 * with "The datasource.url property is required in your Prisma config file", which points
 * nowhere near the real cause.
 *
 * `.mjs` because the staged package.json declares `"type": "module"`.
 */
fs.writeFileSync(
  path.join(serverOut, 'prisma.config.mjs'),
  [
    "import { defineConfig, env } from 'prisma/config';",
    '',
    'export default defineConfig({',
    "  schema: './prisma/schema.prisma',",
    "  datasource: { url: env('DATABASE_URL') },",
    '});',
    '',
  ].join('\n'),
);

console.log('[stage] server: installing production dependencies');
run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], serverOut);

/**
 * The Prisma CLI has to be in the staged tree, for two reasons.
 *
 * At build time, `prisma generate` resolves `@prisma/client` relative to *itself* — running
 * the repo-root CLI against the staged schema fails with "Could not resolve @prisma/client"
 * even though the staged tree has it. At run time, `migrateWithBackup` shells out to this
 * same CLI to apply pending migrations on the user's machine, so it is a runtime
 * dependency of the installer whether or not it is one of the repo.
 *
 * Installed explicitly because it is a devDependency, which `--omit=dev` skipped. Pinned to
 * the version the repo resolved, so the packaged CLI and the generated client cannot drift.
 */
const prismaVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', 'prisma', 'package.json'), 'utf-8'),
).version;

console.log(
  `[stage] server: installing prisma CLI ${prismaVersion} (needed at runtime for migrations)`,
);
run(npm, ['install', '--no-audit', '--no-fund', `prisma@${prismaVersion}`], serverOut);

// A fresh install replaces the generated client in node_modules/@prisma/client with the
// stock package, so regenerating against the staged tree is what makes the packaged server
// able to query at all.
console.log('[stage] server: generating Prisma client');
execFileSync(
  process.execPath,
  [
    path.join(serverOut, 'node_modules', 'prisma', 'build', 'index.js'),
    'generate',
    '--schema',
    path.join(serverOut, 'prisma', 'schema.prisma'),
  ],
  {
    cwd: serverOut,
    stdio: 'inherit',
    // The config written just above is auto-discovered by `generate`, and it resolves
    // DATABASE_URL eagerly — so without a value here the build fails with "Cannot resolve
    // environment variable: DATABASE_URL". Generating a client does not touch a database,
    // so any well-formed URL will do; the real one is supplied at run time.
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/placeholder.db' },
  },
);

// ----------------------------------------------------------------- web -------------
const webSrc = path.join(ROOT, 'apps', 'web');
const webOut = path.join(STAGING, 'web');
console.log('[stage] web: package.json + .next + public');
stagePackageJson(webSrc, webOut);
// Only the production build ships. `.next/dev` (left by `next dev` or the smoke scripts) and
// `.next/cache` are build-machine leftovers that would greatly inflate the installer.
const NEXT_EXCLUDED = new Set(['cache', 'dev', 'trace', 'trace-build']);
fs.cpSync(path.join(webSrc, '.next'), path.join(webOut, '.next'), {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(path.join(webSrc, '.next'), source);
    return !NEXT_EXCLUDED.has(relative.split(path.sep)[0]);
  },
});
if (fs.existsSync(path.join(webSrc, 'public'))) {
  copyDir(path.join(webSrc, 'public'), path.join(webOut, 'public'));
}
// next.config.ts is read by `next start`; without it the rewrite that makes the whole
// single-origin design work simply does not exist in the packaged app.
fs.copyFileSync(path.join(webSrc, 'next.config.ts'), path.join(webOut, 'next.config.ts'));

console.log('[stage] web: installing production dependencies');
run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], webOut);

// -------------------------------------------------- workspace packages -------------
/**
 * The `@projekt-manga/*` packages the server imports at runtime.
 *
 * `stagePackageJson` strips these from dependencies, because their `"*"` workspace versions
 * mean nothing to `npm install` outside the workspace. They must be copied back in: a build
 * under the monorepo (`release/win-unpacked`) would resolve the workspace copies by
 * accident through Node's node_modules walk-up, but any real installation would fail with
 * ERR_MODULE_NOT_FOUND on startup.
 *
 * Copied by hand rather than installed: they are workspace packages with no registry
 * version to install. Only `package.json` and `dist` are needed; their own sources are not.
 *
 * `extensions` is deliberately copied *without* installing its dependencies. Its root entry
 * pulls in puppeteer and playwright, but the server reaches the sandbox through the
 * `/sandbox` subpath, which needs neither — and a sandboxed source could not drive a browser
 * anyway. The health route's stats surface, the only thing that imports the root, loads it
 * lazily and degrades when it is absent.
 */
const WORKSPACE_PACKAGES = ['types', 'schemas', 'extensions'];
const serverScopeDir = path.join(serverOut, 'node_modules', '@projekt-manga');
for (const name of WORKSPACE_PACKAGES) {
  const from = path.join(ROOT, name === 'extensions' ? 'apps' : 'packages', name);
  const to = path.join(serverScopeDir, name);
  const dist = path.join(from, 'dist');
  if (!fs.existsSync(dist)) {
    throw new Error(`[stage] ${name} has no dist/ — build it before staging (looked in ${dist})`);
  }
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(from, 'package.json'), path.join(to, 'package.json'));
  copyDir(dist, path.join(to, 'dist'));
  console.log(`[stage] server: workspace package @projekt-manga/${name}`);
}

// ------------------------------------------------------------ node runtime ----------
// The API child must run on Node >= 25 for the extension sandbox to be enforceable at
// all; Electron's own bundled Node is older. See stage-node-runtime.mjs.
await stageNodeRuntime(STAGING, NODE_CACHE);

console.log('[stage] done ->', STAGING);
