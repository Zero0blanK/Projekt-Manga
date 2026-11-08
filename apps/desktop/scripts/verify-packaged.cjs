/**
 * Fails the build when the packaged app is missing what it needs to start.
 *
 * electron-builder filters `extraResources` silently, so a bad filter still produces a working
 * installer file. The app inside it then can't start its server, and nothing notices until a
 * user installs it.
 */
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED = [
  'server/package.json',
  'server/dist/server.js',
  'server/node_modules/express/package.json',
  'server/node_modules/@projekt-manga/extensions/package.json',
  // The web app is Next's standalone output (scripts/stage-installer.mjs), which keeps the
  // monorepo's shape: server.js under apps/web, beside the traced node_modules.
  'web/apps/web/server.js',
  'web/apps/web/.next/BUILD_ID',
  'web/apps/web/.next/required-server-files.json',
  'web/apps/web/.next/server/app',
  'web/node_modules/next/package.json',
  'web/node_modules/react/package.json',
  'web/node_modules/react-dom/package.json',
  // next/image's optimizer; covers fail to resize without it.
  'web/node_modules/sharp/package.json',
  // Copied in by hand: Next leaves them out of the standalone output for a CDN to serve.
  'web/apps/web/.next/static',
  'web/apps/web/public/brand',
  // The Translate page's OCR engine, fetched by URL (apps/web/scripts/copy-ocr-assets.mjs).
  'web/apps/web/public/ocr/worker.min.js',
  'web/apps/web/public/ocr/core/tesseract-core-simd-lstm.wasm',
  'web/apps/web/public/ocr/core/tesseract-core-simd-lstm.wasm.js',
  'web/apps/web/public/ocr/lang/jpn_vert.traineddata.gz',
  'extensions/dist',
];

const FORBIDDEN = [
  'server/data',
  // The pre-standalone layout. Present alongside the new one, it would mean a stale copy.
  'web/.next',
  // Build-only packages that tracing must not pull into the standalone output.
  'web/node_modules/@next/swc-win32-x64-msvc',
  'web/node_modules/typescript',
];

exports.default = async function verifyPackaged(context) {
  const app = context.packager.appInfo.productFilename;
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${app}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const exists = (entry) => fs.existsSync(path.join(resources, ...entry.split('/')));
  const missing = REQUIRED.filter((entry) => !exists(entry));
  const unwanted = FORBIDDEN.filter(exists);
  if (missing.length > 0 || unwanted.length > 0) {
    throw new Error(
      `[verify] the packaged app is wrong. Missing: ${missing.join(', ') || 'nothing'}. Unwanted: ${unwanted.join(', ') || 'nothing'}.`,
    );
  }
  console.log('[verify] the packaged app has its server, web app and dependencies');
};
