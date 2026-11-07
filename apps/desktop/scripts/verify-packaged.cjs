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
  'web/package.json',
  'web/.next/BUILD_ID',
  'web/node_modules/next/package.json',
  'extensions/dist',
];

const FORBIDDEN = ['server/data'];

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
