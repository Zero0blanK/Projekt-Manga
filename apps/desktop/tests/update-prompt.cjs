const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every offer fetches its changelog; nothing in these tests may reach the network.
globalThis.fetch = async () => new Response('', { status: 404 });

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

test('a changelog.json entry is picked out and sanitised', () => {
  const { updater } = loadUpdater();
  const json = {
    releases: [
      {
        version: '1.1.0',
        date: '2026-11-07',
        summary: 'Summary',
        upgrade: 7,
        changes: [
          { type: 'added', text: ' One ' },
          { type: 'bogus', text: 'Dropped' },
          { type: 'fixed', text: '' },
          { type: 'fixed' },
        ],
        extra: '<script>',
      },
      { version: '1.0.2', date: '2026-10-01', changes: [{ type: 'added', text: 'Old' }] },
    ],
  };
  assert.deepEqual(updater.parseChangelogEntry(json, '1.1.0'), {
    version: '1.1.0',
    date: '2026-11-07',
    summary: 'Summary',
    upgrade: null,
    changes: [{ type: 'added', text: 'One' }],
  });
  assert.equal(updater.parseChangelogEntry(json, '2.0.0'), null);
  assert.equal(updater.parseChangelogEntry(null, '1.1.0'), null);
  assert.equal(updater.parseChangelogEntry({ releases: 'x' }, '1.1.0'), null);
});

test('the changelog of the new version is fetched from its release tag', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(
      JSON.stringify({
        releases: [
          { version: '1.1.0', date: '2026-11-07', changes: [{ type: 'added', text: 'New' }] },
        ],
      }),
    );
  };
  try {
    const { updater, listeners } = loadUpdater();
    listeners['update-available']({ version: '1.1.0', releaseNotes: '' });
    assert.equal(updater.getUpdateState().changelogPending, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(requested, [
      'https://raw.githubusercontent.com/Zero0blanK/Projekt-Manga/v1.1.0/apps/web/src/data/changelog.json',
    ]);
    const state = updater.getUpdateState();
    assert.equal(state.changelogPending, false);
    assert.deepEqual(state.changelog.changes, [{ type: 'added', text: 'New' }]);

    globalThis.fetch = async () => new Response('nope', { status: 404 });
    listeners['update-available']({ version: '1.2.0', releaseNotes: '' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updater.getUpdateState().changelog, null);
    assert.equal(updater.getUpdateState().changelogPending, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a new version prompts once per launch, and "Skip" silences that version', () => {
  const first = loadUpdater();
  first.listeners['update-available']({ version: '1.1.0', releaseNotes: '<p>Notes</p>' });
  assert.equal(first.updater.getUpdateState().prompt, true);
  assert.equal(first.updater.getUpdateState().releaseNotes, 'Notes');

  first.updater.dismissUpdatePrompt('skip');
  assert.equal(first.updater.getUpdateState().prompt, false);
});

test('a new version only prompts: nothing downloads or installs unasked', () => {
  const { updater, listeners, autoUpdater } = loadUpdater();
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  listeners['update-available']({ version: '1.1.0', releaseNotes: '' });
  assert.equal(updater.getUpdateState().status, 'available');
  assert.equal(updater.getUpdateState().prompt, true);
});

test('"Later" quiets that version, but a newer release still prompts', () => {
  const { updater, listeners } = loadUpdater();
  listeners['update-available']({ version: '1.1.0', releaseNotes: '' });
  updater.dismissUpdatePrompt('later');
  listeners['update-available']({ version: '1.1.0', releaseNotes: '' });
  assert.equal(updater.getUpdateState().prompt, false);
  listeners['update-available']({ version: '1.2.0', releaseNotes: '' });
  assert.equal(updater.getUpdateState().prompt, true);
});

test('a failed download stays on offer with its reason', async () => {
  const { updater, listeners } = loadUpdater();
  listeners['update-available']({ version: '1.1.0', releaseNotes: '' });
  await updater.updateNow();
  listeners['error'](new Error('ENOTFOUND github.com'));
  const state = updater.getUpdateState();
  assert.equal(state.status, 'available');
  assert.match(state.error, /Could not reach GitHub/);
});

test('"Update now" installs as soon as the download finishes', async () => {
  const { updater, listeners, autoUpdater } = loadUpdater();
  listeners['update-available']({ version: '1.2.0', releaseNotes: '' });
  await updater.updateNow();
  assert.equal(autoUpdater.installed, 0);
  listeners['update-downloaded']({ version: '1.2.0' });
  assert.equal(autoUpdater.installed, 1);
});
