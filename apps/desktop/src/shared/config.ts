/**
 * Constants shared between the main process and the preload script. Kept separate from
 * both so neither has to import from the other's directory — main and preload run in
 * different Electron contexts and are compiled as independent entry points.
 */

/** IPC channel names, namespaced so they can't collide with anything else on the
 * (shared, per-window) ipcRenderer/ipcMain channel space. */
export const DESKTOP_CHANNELS = {
  openPath: 'desktop:open-path',
  /** One consolidated channel for every local-DB read/write ({domain, op, args} in,
   * {success, message, data} envelope out — the same shape packages/api-client already
   * expects from the HTTP path) rather than a channel per operation, so the sandboxed
   * preload's literal-string channel duplication (see preload/index.ts) stays to one
   * new constant instead of a dozen. */
  dataInvoke: 'desktop:data:invoke',
  authClearCachedSession: 'desktop:auth:clear-cached-session',
  /** Called by the renderer right after a successful register/login. The session cookie
   * is httpOnly (by design — see apps/server's setSessionCookie), so the renderer can
   * never read the session id itself to hand it to the main process; instead this asks
   * the main process to read it directly out of Electron's own cookie store (which isn't
   * subject to the httpOnly-from-page-JS restriction) and update the cached identity the
   * sync runner (main/sync.ts) depends on. */
  authSyncCachedSession: 'desktop:auth:sync-cached-session',
  /** Environment facts for the "Copy diagnostic report" action — see main/diagnostics.ts.
   * Read-only and argument-free, so unlike the other channels there is nothing here to
   * validate as untrusted input. */
  diagnosticsCollect: 'desktop:diagnostics:collect',
  /**
   * Copy text to the OS clipboard through Electron rather than `navigator.clipboard`.
   *
   * The web API refuses with `NotAllowedError: Document is not focused` whenever the page
   * does not hold focus — which in a desktop app includes the perfectly ordinary cases of
   * having DevTools focused, or clicking the button on the way in from another window. The
   * user sees "your browser blocked it" for an action that should simply have worked.
   * Electron's own clipboard has no such requirement.
   */
  clipboardWrite: 'desktop:clipboard:write',
  /** How far this launch's local-database seed has got — polled by the boot splash so it
   * covers the real initialisation instead of lifting onto a library that is still being
   * written. See main/init-state.ts. */
  initGetState: 'desktop:init:get-state',
  /** Self-update channels, backed by main/updater.ts.
   *
   * `updateGetState` is polled by the About panel while it is open rather than pushed from the
   * main process: every channel here is invoke/handle, and a `webContents.send` path plus an
   * `on` listener in the sandboxed preload is more machinery than a download percentage
   * viewed only in that panel is worth. */
  updateGetState: 'desktop:update:get-state',
  updateCheck: 'desktop:update:check',
  updateDownload: 'desktop:update:download',
  updateSetAutoDownload: 'desktop:update:set-auto-download',
  updateInstallNow: 'desktop:update:install-now',
  /** "Update now" from the launch prompt: downloads if needed, then restarts into it. */
  updateNow: 'desktop:update:now',
  /** "Later" or "Skip this version" from the launch prompt. */
  updateDismiss: 'desktop:update:dismiss',
  startupBackgroundGet: 'desktop:startup-background:get',
  startupBackgroundSet: 'desktop:startup-background:set',
} as const;

/**
 * Where the web app is served when no override is set and the app does not supervise its
 * own servers (see main/servers.ts). Overridable via `PROJEKT_MANGA_WEB_URL` to point at a
 * differently-hosted instance without a rebuild.
 */
export const DEFAULT_WEB_URL = 'http://localhost:3000';

/**
 * Hostname the installer serves the app on.
 *
 * RFC 6761 reserves `localhost` and *its subdomains*, and browsers resolve them to
 * loopback without consulting DNS — so this needs no hosts-file edit and no admin rights
 * at install time, while still reading as a product name rather than `localhost:3000`.
 * It also inherits localhost's "potentially trustworthy origin" status, which is what
 * keeps secure-context features and the session cookie working over plain HTTP.
 */
export const LOCAL_APP_HOST = 'projektmanga.localhost';

/** Where the supervised web server is reached, once its port has been chosen at runtime
 * (see main/servers.ts). */
export function buildLocalWebUrl(port: number): string {
  return `http://${LOCAL_APP_HOST}:${port}`;
}

/**
 * Base URL handed to the renderer's api-client.
 *
 * Relative on purpose: the browser resolves it against the page origin, and the web
 * server's own proxy (apps/web `src/proxy.ts`) forwards it to whichever port the API
 * landed on. Nothing port-specific reaches the renderer bundle, which is what makes
 * runtime port selection possible at all.
 */
export const LOCAL_API_BASE_URL = '/api';

/** Rejects anything that isn't a well-formed http(s) URL — a malformed or
 * unexpectedly-schemed PROJEKT_MANGA_WEB_URL (e.g. `file:`/`javascript:`) would otherwise
 * flow straight into `BrowserWindow.loadURL` and the IPC-bridge-exposing window this app
 * creates around it. Falls back to DEFAULT_WEB_URL rather than throwing, since this runs
 * at startup before there's any window to show an error in. */
function isValidWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveWebUrl(): string {
  const configured = process.env.PROJEKT_MANGA_WEB_URL?.trim();
  if (!configured) {
    return DEFAULT_WEB_URL;
  }

  if (!isValidWebUrl(configured)) {
    console.warn(
      `[config] PROJEKT_MANGA_WEB_URL ("${configured}") is not a valid http(s) URL — falling back to ${DEFAULT_WEB_URL}.`,
    );
    return DEFAULT_WEB_URL;
  }

  return configured;
}

/** Where the API server is reached from the main process for the one-time/on-reconnect
 * local-DB seed (db/local-store.ts's seedFromServer) — a separate concern from
 * resolveWebUrl() above (that's the *page* the BrowserWindow loads; this is the *API*
 * that page's own packages/api-client calls also target, matching its own
 * NEXT_PUBLIC_API_URL default). */
export const DEFAULT_API_URL = 'http://localhost:4000/api';

/** Must match apps/server/src/services/auth.service.ts's SESSION_COOKIE_NAME. The main
 * process has no browser cookie jar of its own to read this from automatically (see
 * DESKTOP_CHANNELS.authSyncCachedSession and main/sync.ts) — it either reads the cookie
 * directly out of Electron's session store by this name, or builds the header by hand. */
export const SESSION_COOKIE_NAME = 'pm_session';

export function resolveApiUrl(): string {
  const configured = process.env.PROJEKT_MANGA_API_URL?.trim();
  if (!configured) {
    return DEFAULT_API_URL;
  }

  if (!isValidWebUrl(configured)) {
    console.warn(
      `[config] PROJEKT_MANGA_API_URL ("${configured}") is not a valid http(s) URL — falling back to ${DEFAULT_API_URL}.`,
    );
    return DEFAULT_API_URL;
  }

  return configured;
}
