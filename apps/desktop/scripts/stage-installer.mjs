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
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stageNodeRuntime } from './stage-node-runtime.mjs';
import { bundleServer } from './bundle-server.mjs';

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
  env: { ...process.env, NEXT_PUBLIC_API_URL: '/api', PROJEKT_MANGA_STANDALONE: '1' },
});

if (outputName === undefined) {
  console.log('[stage] clearing', STAGING);
  removeWithRetry(STAGING);
}

// -------------------------------------------------- workspace imports -------------
/**
 * The extension sandbox, the one workspace package the API bundle leaves external.
 *
 * Its `/sandbox` subpath only: the package's root entry pulls in puppeteer and playwright,
 * which a sandboxed source could not drive anyway. (`types` and `schemas` are inside the
 * bundle; see bundle-server.mjs.)
 */
const EXTENSIONS_DIR = path.join(ROOT, 'apps', 'extensions');

/**
 * Every built module the sandbox reaches: the files in dist/sandbox, then whatever they
 * import relatively, followed to the end. The runner is forked by path, so each of them
 * has to ship as a file.
 */
function sandboxModules() {
  const sandboxDir = path.join(EXTENSIONS_DIR, 'dist', 'sandbox');
  if (!fs.existsSync(sandboxDir)) {
    throw new Error(`[stage] extensions: ${sandboxDir} is missing — build apps/extensions first`);
  }
  const pending = fs
    .readdirSync(sandboxDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(sandboxDir, name));
  const found = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (found.has(file)) continue;
    if (!fs.existsSync(file)) {
      throw new Error(
        `[stage] extensions: the sandbox imports ${path.relative(EXTENSIONS_DIR, file)}, which does not exist. Rebuild apps/extensions.`,
      );
    }
    found.add(file);
    const text = fs.readFileSync(file, 'utf-8');
    for (const [, relative] of text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g,
    )) {
      pending.push(path.resolve(path.dirname(file), relative));
    }
  }
  return [...found].sort();
}

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** The package name a bare import specifier refers to ("tldts", "@scope/pkg/sub" -> "@scope/pkg"). */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every bare specifier imported by `files`. Built output only, so a plain scan of
 * `from '…'`, `import('…')` and `require('…')` is enough. */
function bareImports(files) {
  const found = new Set();
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"./][^'"]*)['"]/gm;
  for (const file of files) {
    // Comments survive the build, and one saying from "didn't answer" looks like an import.
    const text = fs.readFileSync(file, 'utf-8').replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, '');
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (!BUILTINS.has(specifier) && !specifier.startsWith('node:')) found.add(specifier);
    }
  }
  return found;
}

/**
 * Third-party packages the sandbox imports, pinned like the server's own.
 *
 * The sandbox is copied in by hand without its dependencies, so a package only it uses
 * (`tldts`) was once missing from the installed app and the API exited with
 * ERR_MODULE_NOT_FOUND on every start. A local or CI build never noticed: under the
 * monorepo, Node's node_modules walk-up found the hoisted copy.
 */
function sandboxRuntimeDependencies() {
  const declared =
    JSON.parse(fs.readFileSync(path.join(EXTENSIONS_DIR, 'package.json'), 'utf-8')).dependencies ??
    {};
  const dependencies = {};
  for (const specifier of bareImports(sandboxModules())) {
    const pkg = packageOf(specifier);
    if (pkg.startsWith('@projekt-manga/')) continue;
    if (!(pkg in declared)) {
      throw new Error(
        `[stage] the extension sandbox imports "${pkg}", but apps/extensions/package.json does not declare it. Add it to its dependencies.`,
      );
    }
    dependencies[pkg] = installedVersion(EXTENSIONS_DIR, pkg) ?? declared[pkg];
  }
  return dependencies;
}

// ----------------------------------------------------------------- server ----------
const serverSrc = path.join(ROOT, 'apps', 'server');
const serverOut = path.join(STAGING, 'server');
/**
 * The API ships as a bundle (scripts/bundle-server.mjs): dist/server.js, dist/app.mjs and its
 * source map, instead of tsc's output beside a full production install. The staged
 * package.json depends only on what the bundle leaves external, so `npm install` below
 * installs just those and their own dependencies.
 */
console.log('[stage] server: bundling the API');
fs.mkdirSync(path.join(serverOut, 'dist'), { recursive: true });
const bundle = await bundleServer({ serverDir: serverSrc, outDir: path.join(serverOut, 'dist') });
console.log(
  `[stage] server: ${bundle.inputs} modules bundled; loaded from node_modules: ${bundle.externals.join(', ')}`,
);
const serverPkg = JSON.parse(fs.readFileSync(path.join(serverSrc, 'package.json'), 'utf-8'));
{
  const declared = { ...serverPkg.dependencies, ...serverPkg.optionalDependencies };
  const pinned = (name) => installedVersion(serverSrc, name) ?? declared[name];
  const dependencies = {};
  const optionalDependencies = {};
  for (const name of bundle.externals) {
    if (name.startsWith('@projekt-manga/')) continue;
    if (!(name in declared)) {
      throw new Error(
        `[stage] the API bundle loads "${name}" at run time, but apps/server/package.json does not declare it. Add it to the server's dependencies.`,
      );
    }
    if (name in (serverPkg.optionalDependencies ?? {})) optionalDependencies[name] = pinned(name);
    else dependencies[name] = pinned(name);
  }
  for (const [name, version] of Object.entries(sandboxRuntimeDependencies())) {
    dependencies[name] ??= version;
  }
  for (const field of ['devDependencies', 'scripts', 'optionalDependencies'])
    delete serverPkg[field];
  serverPkg.dependencies = dependencies;
  if (Object.keys(optionalDependencies).length > 0) {
    serverPkg.optionalDependencies = optionalDependencies;
  }
  fs.writeFileSync(path.join(serverOut, 'package.json'), JSON.stringify(serverPkg, null, 2));
  console.log(
    `[stage] server: runtime dependencies ${Object.entries({
      ...dependencies,
      ...optionalDependencies,
    })
      .map(([n, v]) => `${n}@${v}`)
      .join(', ')}`,
  );
}
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
/**
 * The web app ships as Next's standalone output, not as `.next` plus a full
 * `npm install`.
 *
 * `next build` (with PROJEKT_MANGA_STANDALONE=1, see next.config.ts) traces the files
 * the server loads and copies just those into `.next/standalone`, with a `server.js` to
 * start it. The repository root is the tracing root, so the output mirrors the monorepo:
 * `apps/web/server.js` beside a `node_modules` holding only the traced packages. It is
 * shipped as it is; moving `server.js` away from that `node_modules` would break module
 * resolution.
 *
 * Next leaves two folders out for a CDN to serve, and the desktop app has none, so they
 * are copied in by hand: `.next/static` (the browser's scripts and styles) and `public`
 * (the brand images and the OCR engine under public/ocr, which the Translate page loads
 * by URL). The server serves both once they sit beside it.
 */
const webSrc = path.join(ROOT, 'apps', 'web');
const webOut = path.join(STAGING, 'web');
const standaloneSrc = path.join(webSrc, '.next', 'standalone');
const webApp = path.join(webOut, 'apps', 'web');
if (!fs.existsSync(path.join(standaloneSrc, 'apps', 'web', 'server.js'))) {
  throw new Error(
    `[stage] web: ${path.join(standaloneSrc, 'apps', 'web', 'server.js')} is missing. ` +
      'The web build must run with PROJEKT_MANGA_STANDALONE=1 (next.config.ts sets ' +
      "output: 'standalone' from it), and with the repository root as the tracing root.",
  );
}
console.log('[stage] web: standalone server + .next/static + public');
copyDir(standaloneSrc, webOut);
copyDir(path.join(webSrc, '.next', 'static'), path.join(webApp, '.next', 'static'));
copyDir(path.join(webSrc, 'public'), path.join(webApp, 'public'));

/**
 * Proves every package the web server loads at run time was copied into the standalone
 * output.
 *
 * Turbopack leaves a package it does not bundle as `.x("name", () => require("name"))` in
 * the server chunks, and relies on tracing to have copied it. Tracing follows static
 * `require`s and `import`s; a package that loads files by a computed path can be missed,
 * and nothing would notice until a page using it failed on a user's machine. Resolution
 * must land inside the staged tree: the staging folder sits inside the monorepo, so a
 * missing package would otherwise resolve from the repository's own node_modules.
 */
function verifyWebExternals() {
  const fromServer = createRequire(path.join(webApp, 'server.js'));
  const external = /\.[a-zA-Z]\("([^"]+)",\s*\(\)\s*=>\s*(?:require|import)\("\1"\)\)/g;
  const missing = new Set();
  for (const entry of fs.readdirSync(path.join(webApp, '.next', 'server'), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.(?:m|c)?js$/.test(entry.name)) continue;
    const text = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf-8');
    for (const [, specifier] of text.matchAll(external)) {
      if (BUILTINS.has(specifier) || specifier.startsWith('node:')) continue;
      let resolved = null;
      try {
        resolved = fromServer.resolve(specifier);
      } catch {
        // Reported below.
      }
      if (!resolved || path.relative(webOut, resolved).startsWith('..')) missing.add(specifier);
    }
  }
  if (missing.size > 0) {
    const names = [...missing].map(packageOf);
    throw new Error(
      `[stage] web: the server loads ${[...missing].join(', ')} at run time, but the ` +
        'standalone build did not copy it. Add it to outputFileTracingIncludes in ' +
        "apps/web/next.config.ts, for example: outputFileTracingIncludes: { '/*': [" +
        names.map((name) => `'../../node_modules/${name}/**/*'`).join(', ') +
        '] }',
    );
  }
  console.log('[stage] web: every package the server loads is in the standalone output');
}
verifyWebExternals();

/** Files the Translate page fetches by URL from public/ocr (see scripts/copy-ocr-assets.mjs). */
for (const file of ['worker.min.js', 'lang/jpn_vert.traineddata.gz']) {
  if (!fs.existsSync(path.join(webApp, 'public', 'ocr', ...file.split('/')))) {
    throw new Error(
      `[stage] web: public/ocr/${file} is missing. apps/web's prebuild copies it ` +
        '(scripts/copy-ocr-assets.mjs); run the web build through npm, not `next build`.',
    );
  }
}

// -------------------------------------------------- workspace packages -------------
/**
 * The extension sandbox, which the API bundle leaves external.
 *
 * It cannot be bundled: `spawnSandboxedSource` forks `runner.js` from beside its own module,
 * so the runner has to exist as a file. Copied by hand because it is a workspace package
 * with no registry version to install, and only the sandbox: the package's root entry pulls
 * in puppeteer and playwright, which a sandboxed source could not drive anyway. The health
 * route, the only importer of the root, loads it lazily and degrades when it is absent.
 *
 * Only the modules the sandbox reaches are shipped, with their source maps so stack
 * traces from it name its src/ files.
 */
const serverScopeDir = path.join(serverOut, 'node_modules', '@projekt-manga');
const stagedExtensions = path.join(serverScopeDir, 'extensions');
{
  fs.mkdirSync(stagedExtensions, { recursive: true });
  fs.copyFileSync(
    path.join(EXTENSIONS_DIR, 'package.json'),
    path.join(stagedExtensions, 'package.json'),
  );
  const modules = sandboxModules();
  for (const file of modules) {
    const target = path.join(stagedExtensions, path.relative(EXTENSIONS_DIR, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    if (fs.existsSync(`${file}.map`)) fs.copyFileSync(`${file}.map`, `${target}.map`);
  }
  console.log(`[stage] server: extension sandbox (${modules.length} modules)`);
}

/**
 * Proves every bare import in the shipped server tree resolves *from inside it*.
 *
 * Resolution walks up from the importing file, and the staging directory sits inside the
 * monorepo, so a missing package can still resolve from the repo's hoisted node_modules.
 * Any hit outside the staged tree is therefore a failure, not a pass.
 */
function verifyStagedImports() {
  const missing = [];
  const roots = [
    // The bundle carries plenty of require('…') text from the packages inside it; what it
    // actually loads at run time is the external list esbuild reported.
    { dir: path.join(serverOut, 'dist'), specifiers: bundle.externals },
    // The staged copy of every module the sandbox reaches.
    {
      dir: path.join(stagedExtensions, 'dist', 'sandbox'),
      specifiers: bareImports(
        sandboxModules().map((file) =>
          path.join(stagedExtensions, path.relative(EXTENSIONS_DIR, file)),
        ),
      ),
    },
  ];
  for (const { dir, specifiers } of roots) {
    const from = createRequire(path.join(dir, 'index.js'));
    for (const specifier of specifiers) {
      const pkg = packageOf(specifier);
      // The root entry of extensions is loaded lazily and is meant to be absent here.
      if (pkg === '@projekt-manga/extensions' && specifier === pkg) continue;
      let resolved = null;
      try {
        resolved = from.resolve(`${pkg}/package.json`);
      } catch {
        // Packages that do not export ./package.json: look for the directory directly.
        for (let current = dir; ; current = path.dirname(current)) {
          const candidate = path.join(current, 'node_modules', ...pkg.split('/'));
          if (fs.existsSync(candidate)) {
            resolved = candidate;
            break;
          }
          if (path.dirname(current) === current) break;
        }
      }
      if (!resolved || path.relative(serverOut, resolved).startsWith('..')) {
        missing.push(`${pkg} (imported under ${path.relative(STAGING, dir)})`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[stage] the staged server cannot resolve: ${[...new Set(missing)].join(', ')}`,
    );
  }
  console.log('[stage] server: every shipped import resolves inside the staged tree');
}
verifyStagedImports();

// ------------------------------------------------------------ node runtime ----------
// The API child must run on Node >= 25 for the extension sandbox to be enforceable at
// all; Electron's own bundled Node is older. See stage-node-runtime.mjs.
await stageNodeRuntime(STAGING, NODE_CACHE);

console.log('[stage] done ->', STAGING);
