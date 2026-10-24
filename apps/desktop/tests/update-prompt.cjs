const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Loads dist/main/updater.js against a stub Electron and electron-updater. */
function loadUpdater() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-update-prompt-'));
  const listeners = {};
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: null,
    installed: 0,
    on: (event, handler) => {
      listeners[event] = handler;
    },
    checkForUpdates: async () => {},
    downloadUpdate: async () => {},
    quitAndInstall: () => {
      autoUpdater.installed += 1;
    },
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') {
      return { app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData } };
    }
    if (request === 'electron-updater') return { autoUpdater };
    return originalLoad.call(this, request, ...rest);
  };
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}dist${path.sep}main${path.sep}`)) delete require.cache[key];
  }
  try {
    const updater = require('../dist/main/updater.js');
    updater.initUpdater();
    return { updater, listeners, autoUpdater };
  } finally {
    Module._load = originalLoad;
  }
}

test('release notes from GitHub become plain text', () => {
  const { updater } = loadUpdater();
  assert.equal(
    updater.releaseNotesToText(
      '<h2>What&#39;s new</h2><ul><li>Faster <b>reader</b></li><li>Fixes</li></ul><p>a &amp; b</p>',
    ),
    "What's new\n\n• Faster reader\n• Fixes\n\na & b",
  );
  assert.equal(updater.releaseNotesToText([{ note: '<p>One</p>' }, { note: 'Two' }]), 'One\n\nTwo');
  assert.equal(updater.releaseNotesToText(null), null);
});

test('a new version prompts once per launch, and "Skip" silences that version', () => {
  const first = loadUpdater();
  first.listeners['update-available']({ version: '1.1.0', releaseNotes: '<p>Notes</p>' });
  assert.equal(first.updater.getUpdateState().prompt, true);
  assert.equal(first.updater.getUpdateState().releaseNotes, 'Notes');

  first.updater.dismissUpdatePrompt('skip');
  assert.equal(first.updater.getUpdateState().prompt, false);
  // "Not now" also means not installing behind the user's back on quit.
  assert.equal(first.autoUpdater.autoInstallOnAppQuit, false);
});

test('"Update now" installs as soon as the download finishes', async () => {
  const { updater, listeners, autoUpdater } = loadUpdater();
  autoUpdater.autoDownload = false;
  listeners['update-available']({ version: '1.2.0', releaseNotes: '' });
  await updater.updateNow();
  assert.equal(autoUpdater.installed, 0);
  listeners['update-downloaded']({ version: '1.2.0' });
  assert.equal(autoUpdater.installed, 1);
});
