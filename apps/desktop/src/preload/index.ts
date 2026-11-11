/**
 * Preload script — the only bridge between the renderer (the Next.js app, which must
 * keep working in a plain browser with zero Electron APIs present) and this app's
 * OS-level privileges. Runs with Node access in an isolated context; `contextBridge` is
 * what actually exposes anything to the page, and it exposes exactly this and nothing
 * more.
 *
 * `apps/web/src/components/downloads/open-folder-button.tsx` already probes for
 * `window.desktop?.openPath` and falls back to a clipboard-copy toast when it's absent —
 * this is what makes that bridge real. The shape here has to match that probe exactly:
 * `{ openPath?: (path: string) => Promise<unknown> }`.
 *
 * With `sandbox: true` (see main/window.ts), this script runs in a restricted context
 * that can only `require` Electron itself and a small Node built-in allowlist — it
 * cannot resolve local relative imports like `../shared/config`; such an import makes
 * `contextBridge.exposeInMainWorld` silently never run, leaving `window.desktop`
 * `undefined` with no error. Channel names are therefore duplicated as literals below and
 * must stay in sync with `DESKTOP_CHANNELS` in shared/config.ts, which main/ipc.ts
 * imports normally (the main process isn't sandboxed).
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const OPEN_PATH_CHANNEL = 'desktop:open-path';
const PICK_FOLDER_CHANNEL = 'desktop:pick-folder';
const DATA_INVOKE_CHANNEL = 'desktop:data:invoke';
const AUTH_CLEAR_CACHED_SESSION_CHANNEL = 'desktop:auth:clear-cached-session';
const AUTH_SYNC_CACHED_SESSION_CHANNEL = 'desktop:auth:sync-cached-session';
const DIAGNOSTICS_COLLECT_CHANNEL = 'desktop:diagnostics:collect';
const CLIPBOARD_WRITE_CHANNEL = 'desktop:clipboard:write';
const INIT_GET_STATE_CHANNEL = 'desktop:init:get-state';
const UPDATE_GET_STATE_CHANNEL = 'desktop:update:get-state';
const UPDATE_CHECK_CHANNEL = 'desktop:update:check';
const UPDATE_DOWNLOAD_CHANNEL = 'desktop:update:download';
const UPDATE_INSTALL_NOW_CHANNEL = 'desktop:update:install-now';
const UPDATE_NOW_CHANNEL = 'desktop:update:now';
const UPDATE_DISMISS_CHANNEL = 'desktop:update:dismiss';
const STARTUP_BACKGROUND_GET_CHANNEL = 'desktop:startup-background:get';
const STARTUP_BACKGROUND_SET_CHANNEL = 'desktop:startup-background:set';
const SOURCE_OPEN_BROWSER_CHANNEL = 'desktop:source:open-browser';
const WINDOW_GET_ALWAYS_ON_TOP_CHANNEL = 'desktop:window:get-always-on-top';
const WINDOW_SET_ALWAYS_ON_TOP_CHANNEL = 'desktop:window:set-always-on-top';
const WINDOW_SET_PROGRESS_CHANNEL = 'desktop:window:set-progress';
const WINDOW_SET_BADGE_CHANNEL = 'desktop:window:set-badge';
const CLOSE_TO_TRAY_GET_CHANNEL = 'desktop:close-to-tray:get';
const CLOSE_TO_TRAY_SET_CHANNEL = 'desktop:close-to-tray:set';
const LOCK_GET_STATE_CHANNEL = 'desktop:lock:get-state';
const LOCK_SET_CHANNEL = 'desktop:lock:set';
const LOCK_CLEAR_CHANNEL = 'desktop:lock:clear';
const LOCK_NOW_CHANNEL = 'desktop:lock:now';
const CAPTURE_GET_CHANNEL = 'desktop:capture:get';
const CAPTURE_SET_CHANNEL = 'desktop:capture:set';
/** Main → renderer only (main/renderer-commands.ts): tray and app-menu commands. */
const RENDERER_COMMAND_CHANNEL = 'desktop:command';

/** Prefix of the `additionalArguments` entry main/window.ts appends for us. */
const API_BASE_URL_ARG = '--pm-api-base-url=';

/**
 * The API base URL the renderer's api-client should use, handed down from the main
 * process at window-creation time.
 *
 * Read from `process.argv` rather than `process.env` because this is the mechanism
 * Electron documents for a *sandboxed* preload (`webPreferences.additionalArguments`),
 * and sandboxing is on — see the note above about relative imports silently failing here.
 *
 * Normally `/api`, which routes through the web server's own origin (apps/web's
 * `src/proxy.ts`); that indirection lets the API bind to a port picked at runtime
 * without the renderer bundle knowing it.
 */
function resolveApiBaseUrlArg(): string | undefined {
  const arg = process.argv.find((value) => value.startsWith(API_BASE_URL_ARG));
  const parsed = arg?.slice(API_BASE_URL_ARG.length).trim();
  return parsed || undefined;
}

contextBridge.exposeInMainWorld('desktop', {
  archives: {
    list: () => ipcRenderer.invoke('desktop:archives:list'),
    import: (kind: 'file' | 'folder' = 'file') =>
      ipcRenderer.invoke('desktop:archives:import', kind),
    openPending: () => ipcRenderer.invoke('desktop:archives:open-pending'),
    // For a File from a drop: its path on disk, then the checked import of it.
    importDropped: (file: File) =>
      ipcRenderer.invoke('desktop:archives:import-dropped', webUtils.getPathForFile(file)),
    libraryFolders: () => ipcRenderer.invoke('desktop:archives:library-folders'),
    addLibraryFolder: () => ipcRenderer.invoke('desktop:archives:add-library-folder'),
    removeLibraryFolder: (folder: string) =>
      ipcRenderer.invoke('desktop:archives:remove-library-folder', folder),
    rescan: () => ipcRenderer.invoke('desktop:archives:rescan'),
    page: (id: string, index: number) => ipcRenderer.invoke('desktop:archives:page', id, index),
    remove: (id: string) => ipcRenderer.invoke('desktop:archives:remove', id),
  },
  openPath: (targetPath: string) => ipcRenderer.invoke(OPEN_PATH_CHANNEL, targetPath),
  // The OS folder picker. Resolves to { success, data: path | null }.
  pickFolder: (title?: string) => ipcRenderer.invoke(PICK_FOLDER_CHANNEL, title),
  // Consumed by apps/web/src/lib/api-config.ts, which passes it to `configureApiClient`
  // before the first request. Absent in a plain browser, where the build-time
  // NEXT_PUBLIC_API_URL is used instead.
  apiBaseUrl: resolveApiBaseUrlArg(),
  // Local-first data layer (see main/db/local-store.ts). `window.desktop?.data`'s
  // presence is exactly what packages/api-client/src/runtime.ts checks to decide
  // local-vs-remote — so this key existing at all, not just being callable, is load-bearing.
  data: {
    invoke: (domain: string, op: string, args?: unknown) =>
      ipcRenderer.invoke(DATA_INVOKE_CHANNEL, domain, op, args),
  },
  // Read by apps/web/src/lib/diagnostics.ts to build the pasteable report. The main
  // process decides what is in it — see main/diagnostics.ts's allowlist.
  diagnostics: {
    collect: () => ipcRenderer.invoke(DIAGNOSTICS_COLLECT_CHANNEL),
  },
  // Copying through the OS rather than navigator.clipboard, which refuses whenever the page
  // is not focused — DevTools being focused is enough to break it.
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke(CLIPBOARD_WRITE_CHANNEL, text),
  },
  // Startup progress (main/init-state.ts), polled by the boot splash so it holds until the
  // local database has actually been populated rather than lifting onto an empty one.
  init: {
    getState: () => ipcRenderer.invoke(INIT_GET_STATE_CHANNEL),
  },
  // Self-update (main/updater.ts). `getState` is what the About panel polls while it is open —
  // there is no push channel here on purpose; see the note on DESKTOP_CHANNELS.updateGetState.
  update: {
    getState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
    check: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
    download: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
    installNow: () => ipcRenderer.invoke(UPDATE_INSTALL_NOW_CHANNEL),
    updateNow: () => ipcRenderer.invoke(UPDATE_NOW_CHANNEL),
    dismiss: (choice: 'later' | 'skip') => ipcRenderer.invoke(UPDATE_DISMISS_CHANNEL, choice),
  },
  startupBackground: {
    getState: () => ipcRenderer.invoke(STARTUP_BACKGROUND_GET_CHANNEL),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(STARTUP_BACKGROUND_SET_CHANNEL, enabled),
  },
  // A source's website in an isolated window (main/source-browser.ts), for Cloudflare checks
  // and logins. Resolves once the window is closed and its cookies are saved by the server.
  source: {
    // `closeWhenPassed`: the app opened it by itself, so it closes once the site shows.
    openBrowser: (sourceId: string, options?: { closeWhenPassed?: boolean }) =>
      ipcRenderer.invoke(SOURCE_OPEN_BROWSER_CHANNEL, {
        sourceId,
        closeWhenPassed: options?.closeWhenPassed === true,
      }),
  },
  // The calling window only (main/ipc.ts): the reader's "keep window on top".
  window: {
    getAlwaysOnTop: () => ipcRenderer.invoke(WINDOW_GET_ALWAYS_ON_TOP_CHANNEL),
    setAlwaysOnTop: (enabled: boolean) =>
      ipcRenderer.invoke(WINDOW_SET_ALWAYS_ON_TOP_CHANNEL, enabled),
    setProgress: (fraction: number | null) =>
      ipcRenderer.invoke(WINDOW_SET_PROGRESS_CHANNEL, fraction),
    // `image`: the badge drawn by the page, a small PNG data URL (Windows' overlay icon).
    setBadge: (count: number, image?: string) =>
      ipcRenderer.invoke(WINDOW_SET_BADGE_CHANNEL, { count, image }),
  },
  // App lock settings (main/app-lock.ts). Unlocking happens in the lock window only.
  lock: {
    getState: () => ipcRenderer.invoke(LOCK_GET_STATE_CHANNEL),
    set: (input: { currentPin?: string; newPin: string; idleMinutes: number }) =>
      ipcRenderer.invoke(LOCK_SET_CHANNEL, input),
    clear: (input: { currentPin: string }) => ipcRenderer.invoke(LOCK_CLEAR_CHANNEL, input),
    lockNow: () => ipcRenderer.invoke(LOCK_NOW_CHANNEL),
  },
  capture: {
    getHidden: () => ipcRenderer.invoke(CAPTURE_GET_CHANNEL),
    setHidden: (hidden: boolean) => ipcRenderer.invoke(CAPTURE_SET_CHANNEL, hidden),
  },
  closeToTray: {
    getState: () => ipcRenderer.invoke(CLOSE_TO_TRAY_GET_CHANNEL),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(CLOSE_TO_TRAY_SET_CHANNEL, enabled),
  },
  // Tray and app-menu commands. Only the command object reaches the page, never the
  // Electron event; returns the unsubscribe function.
  commands: {
    subscribe: (listener: (command: unknown) => void) => {
      const forward = (_event: unknown, command: unknown) => listener(command);
      ipcRenderer.on(RENDERER_COMMAND_CHANNEL, forward);
      return () => {
        ipcRenderer.removeListener(RENDERER_COMMAND_CHANNEL, forward);
      };
    },
  },
  auth: {
    clearCachedSession: () => ipcRenderer.invoke(AUTH_CLEAR_CACHED_SESSION_CHANNEL),
    // Called right after a successful renderer-side register/login — see main/ipc.ts's
    // handler for why this takes {user_id, email} rather than the session id itself.
    syncCachedSession: (info: { user_id: string; email: string }) =>
      ipcRenderer.invoke(AUTH_SYNC_CACHED_SESSION_CHANNEL, info),
  },
});
