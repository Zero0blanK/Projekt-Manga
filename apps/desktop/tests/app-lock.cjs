const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Loads dist/main/app-lock.js against a stub Electron with windows that record what
 * happens to them. */
function loadAppLock(userData) {
  const handlers = new Map();
  const windows = [];
  class BrowserWindow {
    constructor(options = {}) {
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.listeners = new Map();
      this.webContents = { on() {}, setWindowOpenHandler() {} };
      windows.push(this);
    }
    static getAllWindows() {
      return windows.filter((win) => !win.destroyed);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {}
    once(event, listener) {
      this.listeners.set(event, listener);
    }
    on(event, listener) {
      this.listeners.set(event, listener);
    }
    close() {
      this.destroyed = true;
      this.listeners.get('closed')?.();
    }
    async loadURL(url) {
      this.url = url;
      this.listeners.get('ready-to-show')?.();
    }
  }
  const electron = {
    app: { getPath: () => userData, quit: () => {} },
    BrowserWindow,
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve('../dist/main/app-lock.js');
  delete require.cache[modulePath];
  try {
    return { lock: require(modulePath), handlers, windows, BrowserWindow };
  } finally {
    Module._load = originalLoad;
  }
}

test('the app lock keeps only a hash, locks the windows and unlocks from the lock window only', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-app-lock-'));
  try {
    let { lock, handlers, windows, BrowserWindow } = loadAppLock(userData);
    lock.initializeAppLock();
    assert.deepEqual(lock.getAppLockState(), { enabled: false, idleMinutes: 0, locked: false });

    for (const input of [
      { newPin: '12345', idleMinutes: 5 },
      { newPin: 'x'.repeat(65), idleMinutes: 5 },
      { newPin: '123456', idleMinutes: 7 },
      null,
    ])
      await assert.rejects(lock.setAppLock(input), undefined, JSON.stringify(input));
    await lock.setAppLock({ newPin: '246810', idleMinutes: 5 });
    const stored = fs.readFileSync(path.join(userData, 'app-lock.json'), 'utf8');
    assert.ok(!stored.includes('246810'), 'The PIN itself is never stored');

    // Locking hides the visible app window and shows the lock window.
    const appWindow = new BrowserWindow();
    appWindow.show();
    lock.lockApp();
    assert.equal(lock.isAppLocked(), true);
    assert.equal(appWindow.isVisible(), false);
    const lockWindow = windows.at(-1);
    assert.notEqual(lockWindow, appWindow);
    assert.ok(lockWindow.options.webPreferences.preload.endsWith(path.join('preload', 'lock.js')));
    assert.equal(lockWindow.options.webPreferences.sandbox, true);

    const unlock = handlers.get('desktop:lock:unlock');
    // An app page can't unlock, even with the right PIN.
    assert.equal((await unlock({ sender: appWindow.webContents }, '246810')).ok, false);
    assert.equal(lock.isAppLocked(), true);
    assert.equal((await unlock({ sender: lockWindow.webContents }, '0000')).ok, false);
    const opened = [];
    lock.whenUnlocked(() => opened.push('loaded'));
    assert.deepEqual(opened, []);
    assert.equal((await unlock({ sender: lockWindow.webContents }, '246810')).ok, true);
    assert.equal(lock.isAppLocked(), false);
    assert.equal(appWindow.isVisible(), true);
    assert.deepEqual(opened, ['loaded']);

    // Turning it off needs the current PIN.
    await assert.rejects(lock.clearAppLock({ currentPin: '1111' }), /wrong/);
    // A restart starts locked.
    ({ lock, handlers, windows } = loadAppLock(userData));
    lock.initializeAppLock();
    assert.equal(lock.isAppLocked(), true);
    const restartedLockWindow = windows.at(-1);
    assert.equal(
      (
        await handlers.get('desktop:lock:unlock')(
          { sender: restartedLockWindow.webContents },
          '246810',
        )
      ).ok,
      true,
    );
    await lock.clearAppLock({ currentPin: '246810' });
    assert.equal(fs.existsSync(path.join(userData, 'app-lock.json')), false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('wrong guesses earn a growing wait, kept across a restart', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-app-lock-'));
  try {
    let { lock, handlers, windows } = loadAppLock(userData);
    lock.initializeAppLock();
    await lock.setAppLock({ newPin: 'correct horse', idleMinutes: 0 });
    lock.lockApp();
    const sender = windows.at(-1).webContents;
    const unlock = handlers.get('desktop:lock:unlock');
    for (let i = 0; i < 5; i++) assert.equal((await unlock({ sender }, 'nope')).ok, false);
    const waiting = await unlock({ sender }, 'correct horse');
    assert.equal(waiting.ok, false);
    assert.match(waiting.message, /Too many attempts/);

    ({ lock, handlers, windows } = loadAppLock(userData));
    lock.initializeAppLock();
    const after = await handlers.get('desktop:lock:unlock')(
      { sender: windows.at(-1).webContents },
      'correct horse',
    );
    assert.match(after.message, /Too many attempts/, 'A restart does not reset the wait');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('guesses sent all at once still earn the wait', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-app-lock-'));
  try {
    const { lock, handlers, windows } = loadAppLock(userData);
    lock.initializeAppLock();
    await lock.setAppLock({ newPin: 'correct horse', idleMinutes: 0 });
    lock.lockApp();
    const sender = windows.at(-1).webContents;
    const unlock = handlers.get('desktop:lock:unlock');
    // Twenty guesses before any is judged, the correct PIN last: only the first five are
    // checked, the rest (the correct one included) meet the wait.
    const guesses = [...Array.from({ length: 19 }, (_, i) => `guess ${i}`), 'correct horse'];
    const results = await Promise.all(guesses.map((pin) => unlock({ sender }, pin)));
    assert.equal(
      results.filter((result) => /Too many attempts/.test(result.message ?? '')).length,
      15,
    );
    assert.equal(results.at(-1).ok, false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('an unreadable lock file stays locked rather than opening the app', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-app-lock-'));
  try {
    fs.writeFileSync(path.join(userData, 'app-lock.json'), '{not json');
    const { lock } = loadAppLock(userData);
    lock.initializeAppLock();
    assert.equal(lock.isAppLocked(), true);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
