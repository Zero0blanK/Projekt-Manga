/**
 * Bundles the API into a few files for the desktop installer.
 *
 * The staged server used to be tsc's output (hundreds of files) beside a full production
 * `npm install` (thousands more). Every one of them is read on start, and on the first start
 * after an update antivirus scans each freshly written file as it is first opened, which
 * made that start take over ten seconds. One bundle is one file to scan.
 *
 *   dist/server.js     a few lines: turns on source maps, then imports app.mjs
 *   dist/app.mjs       the API and every pure-JavaScript package it uses
 *   dist/app.mjs.map   so stack traces in logs and diagnostic reports name src/ files
 *
 * Some packages stay in node_modules, loaded at run time (EXTERNAL below):
 *   - the extension sandbox, which forks its runner from its own folder;
 *   - Prisma's client, which loads the client generated into node_modules/.prisma and its
 *     query engine files by path;
 *   - packages with native binaries (libsql, sharp, bcrypt);
 *   - packages that read their own files by path (swagger-ui-dist's assets).
 *
 * The staged package.json is rewritten to depend on just those, so `npm install` in the
 * staging folder installs nothing the bundle already contains.
 *
 * Adding a package to the server later: if the build fails here, the message says which
 * list to add it to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import * as esbuild from 'esbuild';

/**
 * Loaded from node_modules at run time instead of bundled, with why.
 *
 * Matched against the package name of every import, so subpaths (`@prisma/client/runtime`)
 * follow their package.
 */
export const EXTERNAL = {
  '@projekt-manga/extensions':
    'The sandbox forks dist/sandbox/runner.js from beside its own module; the root entry is optional and loaded lazily by the health route.',
  '@prisma/client':
    'Loads the client generated into node_modules/.prisma, and its engine files, by path.',
  '@prisma/adapter-libsql': 'Depends on libsql, a native package.',
  '@libsql/client': 'Depends on libsql, a native package.',
  libsql: 'Native binary (.node), loaded by platform package name.',
  sharp: 'Native binary, and optional: the server degrades without it.',
  bcrypt: 'Native binary (.node).',
  // swagger-ui-express itself is bundled, so it shares the bundle's express: external, its
  // peer dependency on express would install a second copy of express and all its packages.
  'swagger-ui-dist': 'Serves its assets from its own folder (absolute-path.js uses __dirname).',
};

/**
 * Bundled packages that mention their own location (`__dirname`, `__filename` or
 * `import.meta.url`), each checked to work from inside the bundle, with why.
 *
 * A package that reads its own files by path breaks when bundled, and nothing fails until
 * that code runs on a user's machine. So any bundled package mentioning its location must
 * be reviewed and listed here, or listed in EXTERNAL instead.
 */
export const BUNDLED_LOCATION_USERS = {
  '@projekt-manga/server':
    'docs.route.ts finds openapi.yaml from either layout; server.ts and migrate.ts resolve the package root, which is the same from dist/app.mjs as from dist/server.js.',
  undici:
    'Reads __filename behind a typeof guard, only to label its own stack frames; its WASM parser is inlined as base64.',
};

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** The package name of a bare specifier ("@scope/pkg/sub" -> "@scope/pkg"). */
export function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The package an input file of the bundle belongs to, or null for the server's own code. */
function packageOfInput(file) {
  const normal = file.replace(/\\/g, '/');
  const index = normal.lastIndexOf('node_modules/');
  if (index !== -1) return packageOf(normal.slice(index + 'node_modules/'.length));
  if (normal.includes('packages/types/')) return '@projekt-manga/types';
  if (normal.includes('packages/schemas/')) return '@projekt-manga/schemas';
  if (normal.includes('apps/server/')) return '@projekt-manga/server';
  return null;
}

/**
 * Builds dist/app.mjs and dist/server.js into `outDir` from the server's sources.
 *
 * Returns the external packages the bundle imports, so the caller can install exactly
 * those.
 */
export async function bundleServer({ serverDir, outDir }) {
  const appFile = path.join(outDir, 'app.mjs');
  let result;
  try {
    result = await esbuild.build({
      entryPoints: [path.join(serverDir, 'src', 'server.ts')],
      outfile: appFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node25',
      // No `conditions` or `mainFields` overrides: esbuild's defaults pick a package's
      // `require` build for a require() call and its `import` build for an import, as Node
      // does. Forcing `import` everywhere handed router's require('is-promise') the ESM
      // build, a namespace object rather than a function, and every request failed.
      external: Object.keys(EXTERNAL).flatMap((name) => [name, `${name}/*`]),
      // Bundled CommonJS packages call require() for Node's own modules, which an ES
      // module does not have.
      banner: {
        js: "import { createRequire as __pmCreateRequire } from 'node:module'; const require = __pmCreateRequire(import.meta.url);",
      },
      sourcemap: 'linked',
      // Names and lines are what a stack trace needs; the sources themselves would more than
      // double the map for nothing a user's log uses.
      sourcesContent: false,
      // Keeps class and function names in stack traces and error messages.
      keepNames: true,
      metafile: true,
      logLevel: 'silent',
      legalComments: 'none',
    });
  } catch (error) {
    const messages = (error.errors ?? []).map((e) => e.text).join('\n');
    const nativeFile = /No loader is configured for "\.node" files: (.*)/.exec(messages);
    if (nativeFile) {
      const name = packageOfInput(nativeFile[1]) ?? nativeFile[1];
      throw new Error(
        `[bundle] ${name} contains a native binary and cannot be bundled. Add it to EXTERNAL in apps/desktop/scripts/bundle-server.mjs: '${name}': 'Native binary (.node).'`,
      );
    }
    throw new Error(`[bundle] esbuild failed:\n${messages || error.message}`);
  }

  // Bundled packages that mention their own location must have been reviewed.
  const unreviewed = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    const name = packageOfInput(input);
    if (!name || name in BUNDLED_LOCATION_USERS || name in EXTERNAL) continue;
    if (!/\.(?:[cm]?js|ts)$/.test(input)) continue;
    const text = fs.readFileSync(path.resolve(input), 'utf-8');
    if (/\b__dirname\b|\b__filename\b|import\.meta\.url|import\.meta\.dirname/.test(text)) {
      unreviewed.set(name, input);
    }
  }
  if (unreviewed.size > 0) {
    const lines = [...unreviewed].map(([name, file]) => `  ${name} (${file})`);
    throw new Error(
      [
        '[bundle] These bundled packages refer to their own location, so they may read files by path, which breaks once bundled:',
        ...lines,
        'Check each one. If it reads its own files at run time, add it to EXTERNAL in apps/desktop/scripts/bundle-server.mjs;',
        "if it does not, add it to BUNDLED_LOCATION_USERS there with the reason, e.g. 'name': 'Only resolves a path the caller passes.'",
      ].join('\n'),
    );
  }

  // esbuild names sources relative to the output folder, which on a user's machine Node
  // would resolve against the install folder into a path that never existed there. Named
  // from the repository root instead, a stack frame reads
  // `projekt-manga:///apps/server/src/server.ts:164:7`, with no build-machine path in it.
  const mapFile = `${appFile}.map`;
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf-8'));
  const repoRoot = path.resolve(serverDir, '..', '..');
  map.sources = map.sources.map((source) => {
    const relative = path.relative(repoRoot, path.resolve(outDir, source)).replace(/\\/g, '/');
    return `projekt-manga:///${relative.replace(/^(\.\.\/)+/, '')}`;
  });
  fs.writeFileSync(mapFile, JSON.stringify(map));

  const externals = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const { path: specifier, external } of output.imports) {
      if (external && !BUILTINS.has(specifier)) externals.add(packageOf(specifier));
    }
  }

  // A loader, so source maps are on before the bundle is parsed. `process.setSourceMapsEnabled`
  // only applies to modules loaded after it, and a flag on the command line would depend on
  // every launcher (the supervisor, scripts, a user's own `node dist/server.js`) passing it.
  fs.writeFileSync(
    path.join(outDir, 'server.js'),
    [
      '// The bundled API (apps/desktop/scripts/bundle-server.mjs). Source maps first, so stack',
      '// traces name src/ files and lines rather than positions in app.mjs.',
      'process.setSourceMapsEnabled(true);',
      "await import('./app.mjs');",
      '',
    ].join('\n'),
  );

  return { externals: [...externals].sort(), inputs: Object.keys(result.metafile.inputs).length };
}
