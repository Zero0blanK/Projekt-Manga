/**
 * Electron main process entry point. Owns app lifecycle, the single window, and the
 * privileged IPC handlers the preload bridge exposes to it.
 */
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, Menu } from 'electron';
import { createMainWindow } from './window';
import { rescueAnonymousLibrary } from './library-rescue';
import { registerIpcHandlers } from './ipc';
import { getDb } from './db/connection';
import { localStore } from './db/local-store';
import { buildLocalWebUrl, LOCAL_API_BASE_URL, resolveApiUrl } from '../shared/config';
import { resolveServerPaths, shouldManageServers, startServers, stopServers } from './servers';
import { resolveServerTokenKey } from './server-secrets';
import { captureConsole } from './log-buffer';
import { recordStartupError } from './diagnostics';
import { checkForUpdates, initUpdater, startPeriodicUpdateChecks } from './updater';
import {
  markApiFailed,
  markApiReady,
  markApiStarting,
  markLocalDataPresence,
  markSeedFailed,
  markSeedFinished,
  markSeedStarted,
} from './init-state';
import { buildAppMenu } from './app-menu';
import { initializeAppLock } from './app-lock';
import { sendRendererCommand, setMainWindow } from './renderer-commands';
import { comicPathsFromArgs, onComicOpenQueued, queueComicOpen } from './local-archives';
import {
  initializeCloseToTray,
  initializeStartupBackground,
  markQuitting,
  shouldHideWindowOnClose,
  showBackgroundWindow,
} from './startup-background';

// First, so everything below that warns or fails also reaches the diagnostic report.
captureConsole();

// Without these, a main-process exception or a renderer crash dies silently — no log,
// just an unresponsive window or a process that exits with nothing printed. Neither
// restarts anything; they only make the failure visible.
process.on('uncaughtException', (error) => {
  console.error('[main] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled promise rejection:', reason);
});

// A GPU or utility process crash is otherwise invisible: the window just renders wrong.
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit') return;
  console.error(
    `[main] ${details.type} process gone (${details.reason}, exit code ${details.exitCode})`,
  );
});

// One window, one app instance. A second launch (double-clicking the icon again, or
// running `npm run dev:desktop` a second time) hands off to the existing window instead
// of opening a competing one — competing windows would otherwise be reading/writing the
// same on-disk downloads and settings at once.
/** Roughly a minute of waiting for the API, at the same 1s cadence the window loader
 * uses for the web app — long enough to cover a cold `npm run dev:server` start. */
const SEED_MAX_ATTEMPTS = 30;
const SEED_RETRY_DELAY_MS = 2000;
let revealWhenReady = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // "Open with Projekt Manga": on Windows and Linux the file arrives on the command line
  // (this launch's, or a second launch's handed over below); macOS sends open-file, which
  // can come before the app is ready. Either way it is queued and the window is told.
  for (const file of comicPathsFromArgs(process.argv)) queueComicOpen(file);
  app.on('open-file', (event, file) => {
    event.preventDefault();
    queueComicOpen(file);
  });
  onComicOpenQueued(() => {
    showBackgroundWindow();
    sendRendererCommand({ type: 'open-pending' });
  });

  app.on('second-instance', (_event, commandLine) => {
    for (const file of comicPathsFromArgs(commandLine)) queueComicOpen(file);
    if (commandLine.includes('--pm-background-start')) return;
    if (BrowserWindow.getAllWindows().length === 0) revealWhenReady = true;
    else showBackgroundWindow();
  });

  /**
   * Starts the bundled API and web app, when this build is responsible for them.
   *
   * Sets `PROJEKT_MANGA_WEB_URL` / `PROJEKT_MANGA_API_URL` rather than threading the
   * ports through every call site: `resolveWebUrl()` and `resolveApiUrl()` already read
   * them, so the window loader, the local-DB seed and main/sync.ts all pick up the chosen
   * ports with no further change.
   *
   * Returns the base URL the renderer should use, or undefined to leave it on its
   * build-time default (the dev setup, where the developer started both servers).
   */
  async function startManagedServers(): Promise<string | undefined> {
    if (!shouldManageServers(app.isPackaged)) return undefined;

    // app.getAppPath() is apps/desktop in a monorepo run; the repo root is two up.
    const appRoot = path.join(app.getAppPath(), '..', '..');
    const paths = resolveServerPaths(process.resourcesPath, appRoot);

    if (!paths) {
      console.warn(
        '[main] Managed servers requested but no bundled API/web build was found — falling back to whatever is already running.',
      );
      return undefined;
    }

    // Alongside the desktop's own local cache, in a directory the OS guarantees is
    // writable and preserves across updates.
    const databaseFile = path.join(app.getPath('userData'), 'projektmanga.db');
    // Same directory, same reasoning: writable without elevation, and preserved across
    // updates so installed sources survive one.
    const extensionBundlesDir = path.join(app.getPath('userData'), 'installed-extensions');
    let tokenEncryptionKey: string | undefined;
    try {
      tokenEncryptionKey = resolveServerTokenKey();
    } catch (error) {
      // Not fatal: only stored credentials need it, and the server says so when asked.
      console.warn(
        '[main] Could not prepare the server encryption key:',
        error instanceof Error ? error.message : String(error),
      );
    }
    markApiStarting();
    const { apiPort, webPort, ready, apiReady } = await startServers(
      paths,
      databaseFile,
      extensionBundlesDir,
      { tokenEncryptionKey },
    );
    process.env.PROJEKT_MANGA_WEB_URL = buildLocalWebUrl(webPort);
    process.env.PROJEKT_MANGA_API_URL = `http://127.0.0.1:${apiPort}/api`;

    apiReady.then(markApiReady, markApiFailed);

    // Not awaited: the window is created immediately and shows its own "Starting…"
    // screen while these boot. Failures still have to be visible, hence the catch.
    ready.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[main] Bundled servers did not become ready:', message);
      recordStartupError('servers-ready', error);
    });

    return LOCAL_API_BASE_URL;
  }

  // Children hold their ports and, on Windows, are not reaped by the OS when the parent
  // exits — without this the next launch finds the ports occupied.
  app.on('will-quit', stopServers);
  app.on('before-quit', markQuitting);

  /** Tells the reader why local data is unavailable. Resolves false when they chose Quit. */
  async function reportLocalCacheFailure(error: unknown): Promise<boolean> {
    // The home directory carries the account name; the copied text goes into issues.
    const message = (error instanceof Error ? error.message : String(error))
      .split(os.homedir())
      .join('~');
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Projekt Manga',
      message: "Projekt Manga couldn't open its local data",
      detail:
        `${message}\n\nThe app can still open, but offline reading, local progress and ` +
        'downloads may not work until this is fixed. Settings › About › Review diagnostic ' +
        'report has the details.',
      buttons: ['Open anyway', 'Copy details', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 1) {
      clipboard.writeText(
        [
          `Projekt Manga ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`,
          `Local cache failed to open: ${message}`,
        ].join('\n'),
      );
    }
    return response !== 2;
  }

  app.whenReady().then(async () => {
    // Match electron-builder's appId so Windows attributes renderer notifications to
    // Projekt Manga instead of the generic Electron process where supported.
    if (process.platform === 'win32') app.setAppUserModelId('com.projektmanga.desktop');
    // The app already has its own top nav (FloatingNav) rendered in the page itself, so
    // the menu bar is hidden (window.ts sets autoHideMenuBar; Alt shows it). The menu is
    // still set for its keyboard accelerators: Ctrl+Shift+P, Ctrl+1–5, F11. See app-menu.ts.
    Menu.setApplicationMenu(buildAppMenu());

    // Opens the local DB and runs any pending migrations synchronously, so a broken
    // migration fails loudly at startup instead of on whatever IPC call happens to be
    // first. Local-first reads/writes work from here regardless of what happens next.
    try {
      getDb();
    } catch (error) {
      // Not fatal: the servers and the window still start, so the reader can reach
      // Settings and copy a diagnostic report. Without this the app simply never opened.
      console.error('[main] Could not open the local cache:', error);
      recordStartupError('local-cache', error);
      if (!(await reportLocalCacheFailure(error))) {
        app.quit();
        return;
      }
    }

    // Before the window: this is what decides which URL it loads. A failure here is not
    // fatal — the window falls back to the configured/default URL and shows its own
    // "can't connect" screen, which is more useful than no window at all.
    let apiBaseUrl: string | undefined;
    try {
      apiBaseUrl = await startManagedServers();
      // Only the app's own server: a remote one's library isn't this device's to merge into.
      if (apiBaseUrl) void rescueAnonymousLibrary(apiBaseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[main] Failed to start bundled servers:', message);
      recordStartupError('servers-start', error);
    }

    // After the servers, so the diagnostics handler reports the real supervision state.
    registerIpcHandlers({ managedServers: apiBaseUrl !== undefined });
    // Before the window, so a configured lock is in force before anything shows.
    initializeAppLock();

    const startHidden = await initializeStartupBackground();
    await initializeCloseToTray();
    const openWindow = (hidden = false) => {
      const win = createMainWindow({ apiBaseUrl, startHidden: hidden });
      setMainWindow(win);
      win.on('close', (event) => {
        if (shouldHideWindowOnClose()) {
          event.preventDefault();
          win.hide();
        }
      });
      return win;
    };
    openWindow(startHidden && !revealWhenReady);

    // After the window, and deliberately not awaited — same reasoning as the seed below. A
    // check that is slow, rate-limited or offline must not delay the UI, and `checkForUpdates`
    // never rejects, so there is nothing here to catch.
    initUpdater();
    void checkForUpdates();
    startPeriodicUpdateChecks();

    // Best-effort, non-blocking catalog seed so a fresh install has something to browse
    // offline. Signed-in account changes use the bidirectional sync protocol from the
    // renderer scheduler; the seed remains useful before an account is available.
    void seedWhenServerIsUp();

    // macOS convention: clicking the dock icon with no windows open should reopen one,
    // rather than requiring a full relaunch.
    app.on('activate', () => {
      // Same apiBaseUrl as the first window — a reopened window talks to the same
      // already-running servers.
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
      else showBackgroundWindow();
    });
  });

  /**
   * Seeds the local DB, waiting for the API rather than giving up on the first failure.
   *
   * `npm run dev:desktop` on its own starts Electron and nothing else, and even
   * `dev:desktop:all` races: the window is created the moment Electron is ready, while the
   * API is still booting. A single attempt at startup therefore almost always lost the
   * race, logged one cryptic `fetch failed`, and left the local database empty for the rest
   * of the session.
   *
   * The window loader already retries the *web* URL on the same reasoning (see
   * window.ts's LOAD_DEADLINE_MS); this brings the API seed in line with it.
   */
  async function seedWhenServerIsUp(): Promise<void> {
    const apiUrl = resolveApiUrl();

    // Recorded before the first attempt, because it is what decides whether the boot splash
    // has anything worth waiting for: a library already on disk renders immediately and the
    // seed is just a refresh, while an empty one would otherwise be shown *as* empty for as
    // long as the seed takes. See init-state.ts.
    markLocalDataPresence(localStore.listLibrary().length > 0);
    markSeedStarted();

    for (let attempt = 1; attempt <= SEED_MAX_ATTEMPTS; attempt++) {
      try {
        const { mangaCount, historyCount } = await localStore.seedFromServer(apiUrl);
        console.log(`[main] Local DB seeded: ${mangaCount} manga, ${historyCount} history rows`);
        markSeedFinished(mangaCount);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === SEED_MAX_ATTEMPTS) {
          // Not a failure of the app: local-first reads and writes work from an empty
          // database, and the next launch tries again. Says which URL and what to do,
          // because "fetch failed" on its own reads like a crash.
          console.warn(
            `[main] Local DB not seeded — ${apiUrl} did not respond after ${SEED_MAX_ATTEMPTS} attempts (${message}). ` +
              'The app works offline from its local database; start the API (npm run dev:server) and relaunch to seed it.',
          );
          markSeedFailed();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SEED_RETRY_DELAY_MS));
      }
    }
  }

  // macOS convention: apps stay running (visible in the dock) with no windows open,
  // ready to reactivate; everywhere else, closing the last window quits the app.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
