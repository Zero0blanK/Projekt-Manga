/**
 * App lock (Settings › Privacy › App lock): a PIN or password asked for when the app
 * starts and after it has been idle. While locked every app window is hidden, the page
 * is not loaded (at start) and the privileged IPC refuses to run (ipc.ts), and a small
 * separate lock window, with its own preload that can do nothing but try a PIN, is shown.
 *
 * Only a salted scrypt hash is kept, encrypted with the OS keychain (safeStorage) when it
 * is available. Wrong guesses are rate-limited across restarts.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  safeStorage,
  type IpcMainInvokeEvent,
} from 'electron';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
export const PIN_MIN = 4;
export const PIN_MAX = 64;
export const IDLE_CHOICES = [0, 1, 5, 15, 30, 60] as const;
/** Free attempts before each wait, then the wait doubles up to the cap. */
const FREE_ATTEMPTS = 5;
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60_000;
const IDLE_CHECK_MS = 15_000;

const LOCK_PRELOAD = path.join(__dirname, '..', 'preload', 'lock.js');
export const UNLOCK_CHANNEL = 'desktop:lock:unlock';

type Stored = {
  salt: string;
  hash: string;
  idleMinutes: number;
  failures: number;
  waitUntil: number;
};

let config: Stored | null = null;
let locked = false;
let lockWindow: BrowserWindow | null = null;
let hidden: BrowserWindow[] = [];
let unlockListeners: Array<() => void> = [];
let idleTimer: ReturnType<typeof setInterval> | null = null;

const lockFile = () => path.join(app.getPath('userData'), 'app-lock.json');

function scrypt(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(pin, salt, KEY_LENGTH, SCRYPT, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

function read(): Stored | null {
  try {
    const raw = JSON.parse(readFileSync(lockFile(), 'utf8')) as { encrypted?: string } & Stored;
    const data: unknown =
      typeof raw.encrypted === 'string'
        ? JSON.parse(safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64')))
        : raw;
    const value = data as Partial<Stored>;
    if (
      typeof value.salt !== 'string' ||
      typeof value.hash !== 'string' ||
      !(IDLE_CHOICES as readonly number[]).includes(value.idleMinutes as number)
    )
      return null;
    return {
      salt: value.salt,
      hash: value.hash,
      idleMinutes: value.idleMinutes as number,
      failures: Number.isSafeInteger(value.failures) ? (value.failures as number) : 0,
      waitUntil: Number.isFinite(value.waitUntil) ? (value.waitUntil as number) : 0,
    };
  } catch {
    // An unreadable lock file must not quietly unlock the app: a file that exists but
    // can't be read keeps the app locked behind a PIN nobody can enter, which is the
    // safe failure. Only a missing file means "no lock".
    try {
      readFileSync(lockFile());
      return { salt: '', hash: '', idleMinutes: 0, failures: 0, waitUntil: 0 };
    } catch {
      return null;
    }
  }
}

function write(value: Stored | null): void {
  if (!value) {
    rmSync(lockFile(), { force: true });
    return;
  }
  const json = JSON.stringify(value);
  const body = safeStorage.isEncryptionAvailable()
    ? { encrypted: safeStorage.encryptString(json).toString('base64') }
    : value;
  writeFileSync(lockFile(), JSON.stringify(body), 'utf8');
}

export interface AppLockState {
  enabled: boolean;
  idleMinutes: number;
  locked: boolean;
}

export const getAppLockState = (): AppLockState => ({
  enabled: config !== null,
  idleMinutes: config?.idleMinutes ?? 0,
  locked,
});

export const isAppLocked = () => locked;

/** Runs once the app is next unlocked, or now when it isn't locked. */
export function whenUnlocked(callback: () => void): void {
  if (!locked) callback();
  else unlockListeners.push(callback);
}

function validPin(pin: unknown): pin is string {
  return typeof pin === 'string' && pin.length >= PIN_MIN && pin.length <= PIN_MAX;
}

// Attempts run one at a time: the wait is checked before the (slow) hash and a failure
// counted after it, so attempts sent together would otherwise all pass the check first.
let pinQueue: Promise<unknown> = Promise.resolve();

/** Checks a PIN, counting a wrong one. Throws while a wait is in force. */
function checkPin(pin: unknown): Promise<boolean> {
  const attempt = pinQueue.then(() => checkPinNow(pin));
  pinQueue = attempt.catch(() => undefined);
  return attempt;
}

async function checkPinNow(pin: unknown): Promise<boolean> {
  if (!config) return false;
  const now = Date.now();
  if (config.waitUntil > now)
    throw new Error(
      `Too many attempts. Try again in ${Math.ceil((config.waitUntil - now) / 1000)} s.`,
    );
  let match = false;
  if (validPin(pin) && config.hash) {
    const expected = Buffer.from(config.hash, 'base64');
    const actual = await scrypt(pin, Buffer.from(config.salt, 'base64'));
    match = expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  if (match) {
    config.failures = 0;
    config.waitUntil = 0;
  } else {
    config.failures += 1;
    if (config.failures >= FREE_ATTEMPTS) {
      const doublings = config.failures - FREE_ATTEMPTS;
      config.waitUntil = now + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** doublings);
    }
  }
  write(config);
  return match;
}

/** Sets a new PIN, or changes it (then the current one is required). */
export async function setAppLock(input: unknown): Promise<AppLockState> {
  const { currentPin, newPin, idleMinutes } = (input ?? {}) as Record<string, unknown>;
  if (!validPin(newPin))
    throw new Error(`The PIN or password must be ${PIN_MIN}–${PIN_MAX} characters.`);
  if (!(IDLE_CHOICES as readonly number[]).includes(idleMinutes as number))
    throw new Error('Choose how long the app may be idle before it locks.');
  if (config && !(await checkPin(currentPin))) throw new Error('The current PIN is wrong.');
  const salt = randomBytes(16);
  config = {
    salt: salt.toString('base64'),
    hash: (await scrypt(newPin, salt)).toString('base64'),
    idleMinutes: idleMinutes as number,
    failures: 0,
    waitUntil: 0,
  };
  write(config);
  watchIdle();
  return getAppLockState();
}

/** Turns the lock off. Needs the current PIN, so someone at an unlocked app can't. */
export async function clearAppLock(input: unknown): Promise<AppLockState> {
  const { currentPin } = (input ?? {}) as Record<string, unknown>;
  if (!config) return getAppLockState();
  if (!(await checkPin(currentPin))) throw new Error('The current PIN is wrong.');
  config = null;
  write(null);
  watchIdle();
  return getAppLockState();
}

function lockPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Projekt Manga is locked</title>
<style>
  html,body{height:100%;margin:0;background:#16130f;color:#f4f0ea;
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;}
  body{display:flex;align-items:center;justify-content:center;}
  form{display:flex;flex-direction:column;gap:.75rem;width:16rem;text-align:center;}
  h1{font-size:1.05rem;font-weight:600;margin:0;}
  input{background:#221e19;border:1px solid #35302a;color:inherit;border-radius:.5rem;
    padding:.6rem .8rem;font-size:1rem;text-align:center;}
  button{background:#e9a25a;color:#18130f;border:0;padding:.55rem;border-radius:999px;
    font-weight:600;cursor:pointer;}
  p{color:#e88;min-height:1.5em;margin:0;font-size:.85rem;}
</style></head><body>
<form id="f"><h1>Projekt Manga is locked</h1>
<input id="pin" type="password" autocomplete="current-password" aria-label="PIN or password" autofocus>
<button type="submit">Unlock</button><p id="m" role="alert"></p></form>
<script>
  const f = document.getElementById('f'), pin = document.getElementById('pin'), m = document.getElementById('m');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    m.textContent = '';
    const result = await window.appLock.unlock(pin.value);
    pin.value = '';
    if (!result.ok) { m.textContent = result.message; pin.focus(); }
  });
</script></body></html>`;
}

function showLockWindow(): void {
  if (lockWindow && !lockWindow.isDestroyed()) {
    lockWindow.show();
    lockWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 420,
    height: 340,
    resizable: false,
    minimizable: true,
    maximizable: false,
    title: 'Projekt Manga is locked',
    backgroundColor: '#16130f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: LOCK_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The lock page is the only thing this window may ever show.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (lockWindow === win) lockWindow = null;
    // Closing the lock window while locked quits, rather than leaving a hidden, locked app
    // with no way back in but the tray.
    if (locked) app.quit();
  });
  lockWindow = win;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(lockPage())}`);
}

/** Locks now: hides every app window and shows the lock window. */
export function lockApp(): void {
  if (!config || locked) return;
  locked = true;
  hidden = BrowserWindow.getAllWindows().filter(
    (win) => win !== lockWindow && !win.isDestroyed() && win.isVisible(),
  );
  for (const win of hidden) win.hide();
  showLockWindow();
}

function unlock(): void {
  locked = false;
  for (const win of hidden) if (!win.isDestroyed()) win.show();
  hidden = [];
  const listeners = unlockListeners;
  unlockListeners = [];
  for (const listener of listeners) listener();
  const win = lockWindow;
  lockWindow = null;
  win?.close();
}

/** Brings the lock window forward while locked (the tray's "Open", a second launch). */
export function revealLockIfLocked(): boolean {
  if (!locked) return false;
  showLockWindow();
  return true;
}

function watchIdle(): void {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  if (!config || config.idleMinutes === 0) return;
  idleTimer = setInterval(() => {
    if (config && !locked && powerMonitor.getSystemIdleTime() >= config.idleMinutes * 60) lockApp();
  }, IDLE_CHECK_MS);
  // A timer must never be what keeps the process running.
  idleTimer.unref?.();
}

/**
 * Called once the app is ready, before any window: a configured lock starts locked. The
 * unlock channel answers only the lock window, never an app page.
 */
export function initializeAppLock(): void {
  config = read();
  locked = config !== null;
  if (locked) showLockWindow();
  watchIdle();
  powerMonitor.on('lock-screen', () => lockApp());
  ipcMain.handle(UNLOCK_CHANNEL, async (event: IpcMainInvokeEvent, pin: unknown) => {
    if (!lockWindow || event.sender !== lockWindow.webContents)
      return { ok: false, message: 'Not available here.' };
    try {
      if (await checkPin(pin)) {
        unlock();
        return { ok: true, message: '' };
      }
      return { ok: false, message: 'Wrong PIN or password.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Try again.' };
    }
  });
}
