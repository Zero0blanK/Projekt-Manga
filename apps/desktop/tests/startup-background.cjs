const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('background startup registers a login item and keeps the window recoverable', async () => {
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  let loginEnabled = false;
  let trayDestroyed = false;
  let shown = false;
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => {
      shown = true;
    },
    focus: () => {},
  };
  const electron = {
    app: {
      isPackaged: true,
      getLoginItemSettings: () => ({ openAtLogin: loginEnabled }),
      setLoginItemSettings: (settings) => {
        assert.deepEqual(settings.args, ['--pm-background-start']);
        loginEnabled = settings.openAtLogin;
      },
      getFileIcon: async () => ({ isEmpty: () => false }),
      quit: () => {},
    },
    BrowserWindow: { getAllWindows: () => [window] },
    Menu: { buildFromTemplate: (items) => items },
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {
        trayDestroyed = true;
      }
    },
  };

  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Module._load = function (request, parent, isMain) {
      return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain);
    };
    const startup = require('../dist/main/startup-background.js');
    assert.deepEqual(startup.getStartupBackgroundState(), { supported: true, enabled: false });
    await startup.setStartupBackground(true);
    assert.equal(startup.shouldHideWindowOnClose(), true);
    process.argv.push('--pm-background-start');
    assert.equal(await startup.initializeStartupBackground(), true);
    process.argv.pop();
    startup.showBackgroundWindow();
    assert.equal(shown, true);
    assert.equal(startup.getStartupBackgroundState().enabled, true);
    await startup.setStartupBackground(false);
    assert.equal(startup.shouldHideWindowOnClose(), false);
    assert.equal(trayDestroyed, true);
  } finally {
    if (process.argv.at(-1) === '--pm-background-start') process.argv.pop();
    Module._load = originalLoad;
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('close to tray keeps a tray while on, is remembered, and is refused elsewhere', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-close-to-tray-'));
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  let traysCreated = 0;
  let traysDestroyed = 0;
  const electron = {
    app: {
      isPackaged: false,
      getPath: () => userData,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      getFileIcon: async () => ({ isEmpty: () => false }),
      quit: () => {},
    },
    BrowserWindow: { getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items) => items },
    Tray: class {
      constructor() {
        traysCreated++;
      }
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {
        traysDestroyed++;
      }
    },
  };
  const modulePath = require.resolve('../dist/main/startup-background.js');
  const preferencesPath = require.resolve('../dist/main/desktop-preferences.js');
  const fresh = () => {
    delete require.cache[modulePath];
    delete require.cache[preferencesPath];
    return require(modulePath);
  };
  try {
    Module._load = function (request, parent, isMain) {
      return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain);
    };
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let startup = fresh();
    assert.deepEqual(startup.getCloseToTrayState(), { supported: true, enabled: false });
    assert.equal(startup.shouldHideWindowOnClose(), false);
    assert.deepEqual(await startup.setCloseToTray(true), { supported: true, enabled: true });
    assert.equal(traysCreated, 1, 'the tray exists before the window can hide into it');
    assert.equal(startup.shouldHideWindowOnClose(), true);
    startup.markQuitting();
    assert.equal(startup.shouldHideWindowOnClose(), false, 'Quit still quits');

    // Remembered across a restart.
    startup = fresh();
    await startup.initializeCloseToTray();
    assert.equal(startup.shouldHideWindowOnClose(), true);
    await startup.setCloseToTray(false);
    assert.equal(startup.shouldHideWindowOnClose(), false);
    assert.equal(traysDestroyed, 1);

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    startup = fresh();
    assert.equal(startup.getCloseToTrayState().supported, false);
    await assert.rejects(startup.setCloseToTray(true), /unavailable/);
  } finally {
    Module._load = originalLoad;
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    delete require.cache[modulePath];
    delete require.cache[preferencesPath];
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
