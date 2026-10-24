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
import { contextBridge, ipcRenderer } from 'electron';

const OPEN_PATH_CHANNEL = 'desktop:open-path';
const DATA_INVOKE_CHANNEL = 'desktop:data:invoke';
const AUTH_CLEAR_CACHED_SESSION_CHANNEL = 'desktop:auth:clear-cached-session';
const AUTH_SYNC_CACHED_SESSION_CHANNEL = 'desktop:auth:sync-cached-session';
const DIAGNOSTICS_COLLECT_CHANNEL = 'desktop:diagnostics:collect';
const CLIPBOARD_WRITE_CHANNEL = 'desktop:clipboard:write';
const INIT_GET_STATE_CHANNEL = 'desktop:init:get-state';
const UPDATE_GET_STATE_CHANNEL = 'desktop:update:get-state';
const UPDATE_CHECK_CHANNEL = 'desktop:update:check';
const UPDATE_DOWNLOAD_CHANNEL = 'desktop:update:download';
const UPDATE_SET_AUTO_DOWNLOAD_CHANNEL = 'desktop:update:set-auto-download';
const UPDATE_INSTALL_NOW_CHANNEL = 'desktop:update:install-now';
const UPDATE_NOW_CHANNEL = 'desktop:update:now';
const UPDATE_DISMISS_CHANNEL = 'desktop:update:dismiss';
const STARTUP_BACKGROUND_GET_CHANNEL = 'desktop:startup-background:get';
const STARTUP_BACKGROUND_SET_CHANNEL = 'desktop:startup-background:set';

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
    import: () => ipcRenderer.invoke('desktop:archives:import'),
    page: (id: string, index: number) => ipcRenderer.invoke('desktop:archives:page', id, index),
    remove: (id: string) => ipcRenderer.invoke('desktop:archives:remove', id),
  },
  openPath: (targetPath: string) => ipcRenderer.invoke(OPEN_PATH_CHANNEL, targetPath),
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
    setAutoDownload: (enabled: boolean) =>
      ipcRenderer.invoke(UPDATE_SET_AUTO_DOWNLOAD_CHANNEL, enabled),
    installNow: () => ipcRenderer.invoke(UPDATE_INSTALL_NOW_CHANNEL),
    updateNow: () => ipcRenderer.invoke(UPDATE_NOW_CHANNEL),
    dismiss: (choice: 'later' | 'skip') => ipcRenderer.invoke(UPDATE_DISMISS_CHANNEL, choice),
  },
  startupBackground: {
    getState: () => ipcRenderer.invoke(STARTUP_BACKGROUND_GET_CHANNEL),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(STARTUP_BACKGROUND_SET_CHANNEL, enabled),
  },
  auth: {
    clearCachedSession: () => ipcRenderer.invoke(AUTH_CLEAR_CACHED_SESSION_CHANNEL),
    // Called right after a successful renderer-side register/login — see main/ipc.ts's
    // handler for why this takes {user_id, email} rather than the session id itself.
    syncCachedSession: (info: { user_id: string; email: string }) =>
      ipcRenderer.invoke(AUTH_SYNC_CACHED_SESSION_CHANNEL, info),
  },
});
