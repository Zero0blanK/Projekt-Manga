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
