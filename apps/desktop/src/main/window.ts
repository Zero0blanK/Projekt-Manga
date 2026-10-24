/**
 * The app's single BrowserWindow: how it's created, hardened, and kept pointed at the
 * running web app.
 */
import path from 'node:path';
import { app, BrowserWindow, net, session, shell } from 'electron';
import { resolveApiUrl, resolveWebUrl } from '../shared/config';

const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'index.js');

// The packaged app takes its window and taskbar icon from the executable (build/icon.ico,
// embedded by electron-builder). build/ isn't shipped, so this only fills the gap in dev,
// where the window would otherwise show Electron's default icon.
const DEV_ICON_PATH = app.isPackaged
  ? undefined
  : path.join(__dirname, '..', '..', 'build', 'icons', 'icon_256.png');

/** How long to keep waiting for the web app before showing the "can't connect" screen.
 * Covers a dev server still compiling on a cold start — and, in the installer, a first run
 * that also has to apply schema migrations before the web server answers. A time budget
 * rather than an attempt count: a refused connection takes seconds on Windows, so 90
 * attempts "1s apart" stretched to several minutes. */
const LOAD_DEADLINE_MS = 90_000;
const RETRY_DELAY_MS = 1000;
/** Per probe. Generous because the first request to a cold Next dev server compiles. */
const PROBE_TIMEOUT_MS = 15_000;

/** What the failure page's Retry button navigates to. It never resolves (`.invalid` is
 * reserved) and never gets loaded: `hardenNavigation` intercepts it and re-runs
 * `loadWebApp`, so the data: page needs no preload, IPC or script beyond a plain
 * navigation. A reload of a data: URL would only re-render the same failure page. */
const RETRY_URL = 'https://pm-retry.invalid/';

/** Shown between load attempts, and as the final state if every retry is exhausted.
 * Inline and dependency-free — this has to render without the app it's waiting for. */
function connectingHtml(webUrl: string, giveUp: boolean, managed: boolean): string {
  const escaped = webUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // "start the web app yourself" is only actionable in the dev setup. When this build
  // supervises its own servers, telling the user to run `npm run dev:web` is nonsense —
  // the failure is ours, and the diagnostic report is what they can actually act on.
  const failureHelp = managed
    ? `The app's own services didn't start. Try relaunching; if it keeps happening, copy a diagnostic report from Settings → About and include it in a bug report.`
    : `Make sure the web app is running at <code>${escaped}</code> (<code>npm run dev:web</code>), then retry.`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Projekt Manga</title>
<style>
  html,body{height:100%;margin:0;background:#16130f;color:#f4f0ea;
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;}
  body{display:flex;align-items:center;justify-content:center;}
  .card{text-align:center;max-width:26rem;padding:2rem;}
  h1{font-size:1.05rem;font-weight:600;margin:0 0 .5rem;}
  p{color:#a39c8f;margin:0;}
  code{background:#221e19;padding:.15rem .4rem;border-radius:.3rem;font-size:.85em;}
  .spin{width:1.5rem;height:1.5rem;margin:0 auto 1rem;border-radius:50%;
    border:2px solid #35302a;border-top-color:#e9a25a;animation:s 0.8s linear infinite;}
  @keyframes s{to{transform:rotate(360deg)}}
  button{margin-top:1.25rem;background:#e9a25a;color:#18130f;border:0;
    padding:.5rem 1.1rem;border-radius:999px;font-weight:600;font-size:.8rem;cursor:pointer;}
</style></head>
<body><div class="card">
${giveUp ? '' : '<div class="spin"></div>'}
<h1>${giveUp ? 'Couldn&#39;t reach the app' : 'Starting Projekt Manga…'}</h1>
<p>${giveUp ? failureHelp : `Waiting for <code>${escaped}</code> to come up.`}</p>
${giveUp ? `<button onclick="location.href='${RETRY_URL}'">Retry</button>` : ''}
</div></body></html>`;
}

/** Bumped on every loadWebApp call, so a Retry click or crash reload stops the loop it replaces. */
const loadGenerations = new WeakMap<BrowserWindow, number>();

/** Whether anything answers at `url`. Any HTTP response counts; only a network failure or
 * timeout doesn't. Probed from the main process so the window keeps showing the waiting
 * page instead of Chromium's blank error page between attempts.
 *
 * Electron's `net.fetch`, not Node's: the installer serves on `projektmanga.localhost`,
 * which Chromium resolves to loopback itself but Node hands to the OS resolver — and
 * Windows answers ENOTFOUND for localhost subdomains, so a Node probe never succeeds and
 * the window sits on "Starting…" with the server already up. */
async function isServing(url: string): Promise<boolean> {
  try {
    const response = await net.fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/**
 * Points the window at the web app, waiting while it's still starting up rather than
 * showing Chromium's bare connection-refused page. Once it loads successfully this has
 * nothing further to do — Next's own client-side router handles navigation from there.
 */
async function loadWebApp(win: BrowserWindow, managed: boolean): Promise<void> {
  const webUrl = resolveWebUrl();
  const generation = (loadGenerations.get(win) ?? 0) + 1;
  loadGenerations.set(win, generation);
  const superseded = () => win.isDestroyed() || loadGenerations.get(win) !== generation;
  const deadline = Date.now() + LOAD_DEADLINE_MS;

  const showStatus = async (giveUp: boolean) => {
    if (superseded()) return;
    try {
      await win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(connectingHtml(webUrl, giveUp, managed))}`,
      );
    } catch {
      // Interrupted by a newer navigation, which owns the window now.
    }
  };

  await showStatus(false);
  while (!superseded()) {
    if (await isServing(webUrl)) {
      if (superseded()) return;
      try {
        await win.loadURL(webUrl);
        return;
      } catch {
        // It went away between the probe and the load; put the waiting page back.
        await showStatus(false);
      }
    }
    if (Date.now() >= deadline) {
      await showStatus(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

/**
 * Keeps the window pointed at the web app's own origin. Electron's security guidance is
 * to treat every loaded page as a potential attacker and explicitly refuse anything this
 * app doesn't intend — a plain link to an external site should open in the OS browser,
 * not hijack the app window or spawn a second Electron-privileged one.
 */
function hardenNavigation(win: BrowserWindow, webUrl: string, retryLoad: () => void): void {
  const allowedOrigin = new URL(webUrl).origin;

  // An unparseable target is not this app's origin by definition, and letting URL()
  // throw inside an Electron event handler would surface as an unhandled exception
  // rather than as a blocked navigation.
  const isAllowed = (targetUrl: string): boolean => {
    try {
      return new URL(targetUrl).origin === allowedOrigin;
    } catch {
      return false;
    }
  };

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl === RETRY_URL) {
      event.preventDefault();
      retryLoad();
      return;
    }
    if (!isAllowed(targetUrl)) {
      event.preventDefault();
      openExternalIfSafe(targetUrl);
    }
  });

  // A server-side redirect off the app's origin bypasses will-navigate entirely, so it is
  // held to the same rule. Not handed to the OS browser: nothing the user clicked led here.
  win.webContents.on('will-redirect', (event, targetUrl) => {
    if (!isAllowed(targetUrl)) {
      event.preventDefault();
      console.warn('[window] Blocked a redirect to another origin');
    }
  });

  // will-navigate covers the main frame only; this is what sees a subframe navigating
  // somewhere else. (CSP already sets frame-src 'none', so this is a second layer.)
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !isAllowed(event.url)) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
}

/** Schemes it is safe to hand to the OS. Everything else is refused — see below. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Opens a link in the OS browser, but only when it's a scheme meant for one.
 *
 * `shell.openExternal` asks the OS to launch whatever handler is registered for the
 * URL's scheme, so passing it a page-controlled string is the pitfall Electron's own
 * security checklist calls out by name. A `file:` target hands a local executable to its
 * default handler, and Windows in particular registers plenty of protocol handlers
 * (`ms-msdt:`, `search-ms:`) that have been used for code execution. The renderer is our
 * own Next.js app, but a link's href is still page content — an anchor in scraped manga
 * metadata is enough to reach here — so the scheme is checked rather than trusted.
 */
function openExternalIfSafe(rawUrl: string): void {
  let scheme: string;
  try {
    scheme = new URL(rawUrl).protocol;
  } catch {
    return;
  }

  if (!EXTERNAL_SCHEMES.has(scheme)) {
    console.warn(`[window] Refused to open external URL with scheme "${scheme}"`);
    return;
  }

  void shell.openExternal(rawUrl);
}

/**
 * Sends a Content-Security-Policy header on every response this session loads.
 * Defense-in-depth on top of the already-strong webPreferences (contextIsolation,
 * nodeIntegration:false, sandbox) below — those alone mean a compromised page can't reach
 * Node/Electron APIs regardless, but a CSP is still Electron's documented baseline
 * recommendation and costs nothing here. `script-src`/`style-src` keep 'unsafe-inline' and
 * 'unsafe-eval' because this wraps a Next.js dev/prod server this app doesn't control the
 * build output of (HMR, styled-jsx, etc. commonly need them) — tighten this if the web
 * app's own asset pipeline moves to nonce/hash-based CSP. Session-scoped (not per-window)
 * since Electron sessions are shared app-wide; only needs to run once.
 */
function applyContentSecurityPolicy(webUrl: string): void {
  const origin = new URL(webUrl).origin;
  // Cover art and reader pages are served by the API's image proxy, which lives on a
  // different origin to the page (:4000 vs :3000). Without it in img-src, Electron blocks
  // every one of them while a plain browser — which never sees this header — loads them
  // fine, so the app looks correct everywhere except in the desktop build.
  //
  // Needed for the dev setup. In the installer's single-origin mode it is redundant but
  // harmless: covers come back through the web server's own origin (already `${origin}`),
  // and this resolves to the loopback API the renderer never calls directly.
  const apiOrigin = new URL(resolveApiUrl()).origin;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Header names arrive in whatever case the server used. Dropping any existing CSP
    // (case-insensitively) keeps a server-sent one from sitting beside ours, where the
    // browser would enforce both.
    const responseHeaders = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(
        ([name]) => name.toLowerCase() !== 'content-security-policy',
      ),
    );
    callback({
      responseHeaders: {
        ...responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self' ${origin}`,
          `script-src 'self' ${origin} 'unsafe-inline' 'unsafe-eval'`,
          `style-src 'self' ${origin} 'unsafe-inline'`,
          `img-src 'self' ${origin} ${apiOrigin} data: blob:`,
          `font-src 'self' ${origin} data:`,
          // Deliberately broader than the other directives: not scoped to 'self'/${origin}/
          // ${apiOrigin}. Could likely be narrowed to those plus ws:/wss: (for HMR), but
          // that needs a test that nothing else depends on the wider allowance.
          `connect-src 'self' ${origin} http: https: ws: wss:`,
          `media-src 'self' ${origin} ${apiOrigin} data: blob:`,
          `frame-src 'none'`,
          `object-src 'none'`,
        ].join('; '),
      },
    });
  });
}

/**
 * Permissions this app actually asks the browser for. Everything else is refused.
 *
 * `notifications` is requested by the Settings → Notifications panel from a user gesture
 * (see notifications-panel.tsx's useNotificationPermission), and clipboard writes come
 * from the copy buttons on manga and download rows — in the packaged app those go through
 * the preload bridge instead (`desktop:clipboard:write`), but the web code falls back to
 * `navigator.clipboard` and Chromium asks for a grant when it does.
 */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

/**
 * Denies every permission request and check this app has no use for.
 *
 * Electron's default handler approves most requests outright, with no prompt — the
 * security checklist calls this out ("Handle session permission requests from remote
 * content") precisely because an Electron app has no address bar or site-settings UI for
 * a user to undo a grant with. Nothing here loads remote content today: the renderer is
 * this project's own Next.js app and `hardenNavigation` keeps it that way. But that is a
 * property of two other functions rather than of this one, and the cost of not relying on
 * it is an allowlist of two strings.
 *
 * Also scoped by origin, not just by permission name: a grant is only considered for the
 * web app's own origin, so a page that somehow ended up loaded from anywhere else gets
 * nothing regardless of what it asks for.
 *
 * Session-scoped like the CSP above, for the same reason — Electron sessions are
 * app-wide, so this only needs to run once.
 */
function applyPermissionPolicy(webUrl: string): void {
  const allowedOrigin = new URL(webUrl).origin;

  const isAllowed = (permission: string, requestingUrl: string | undefined): boolean => {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false;
    let origin: string | null = null;
    try {
      origin = requestingUrl ? new URL(requestingUrl).origin : null;
    } catch {
      origin = null;
    }
    return origin === allowedOrigin;
  };

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const requestingUrl = webContents?.getURL();
    const allowed = isAllowed(permission, requestingUrl);
    if (!allowed) {
      console.warn(`[window] Denied "${permission}" permission request`);
    }
    callback(allowed);
  });

  // The synchronous sibling: Chromium consults this for `navigator.permissions.query` and
  // for permissions it checks without raising a request. Returning true from the default
  // implementation is what makes a denial above look granted to feature-detecting code.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    isAllowed(permission, requestingOrigin),
  );
}

export interface MainWindowOptions {
  /** API base URL to hand the renderer's api-client, when it should not use its
   * build-time default. `/api` in the installer's single-origin mode; omitted in the dev
   * setup, where the web app already points at a server the developer started. */
  apiBaseUrl?: string;
  /** OS login launch keeps services running without flashing the window. */
  startHidden?: boolean;
}

export function createMainWindow(options: MainWindowOptions = {}): BrowserWindow {
  const webUrl = resolveWebUrl();
  applyContentSecurityPolicy(webUrl);
  applyPermissionPolicy(webUrl);

  // The preload is sandboxed and cannot import shared/config or read this from anywhere
  // else — `additionalArguments` is Electron's documented channel into it. See
  // preload/index.ts's resolveApiBaseUrlArg.
  const additionalArguments = options.apiBaseUrl
    ? [`--pm-api-base-url=${options.apiBaseUrl}`]
    : undefined;

  // A base URL is only handed down when this process started the servers itself, so its
  // presence is what distinguishes the installer from the dev setup for the loading screen.
  const managed = options.apiBaseUrl !== undefined;

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'Projekt Manga',
    backgroundColor: '#16130f',
    icon: DEV_ICON_PATH,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      additionalArguments,
      // The three settings that actually matter for security: no direct Node access in
      // the page, the preload's isolated world stays isolated, and the renderer runs in
      // Chromium's own sandbox. None of this app's Electron-only behaviour needs any of
      // them relaxed — everything privileged goes through the preload bridge instead.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (!options.startHidden) win.once('ready-to-show', () => win.show());
  hardenNavigation(win, webUrl, () => void loadWebApp(win, managed));

  // DevTools in the packaged build, on demand.
  //
  // The renderer's own console is the only place a UI-side failure is visible here: the
  // supervisor's log buffer (log-buffer.ts) captures the two server children's stdout, not
  // the page's, and it lives in memory, so a user hitting a bug in an installed build has
  // nothing to send. Bound to a key rather than opened automatically, and it grants the
  // page nothing — contextIsolation, nodeIntegration and sandbox above are untouched.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isInspectChord = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (isF12 || isInspectChord) {
      win.webContents.toggleDevTools();
    }
  });

  // A renderer crash (OOM, GPU crash, etc.) would otherwise leave the window frozen on its
  // last frame. Reload through loadWebApp(), the same path a fresh launch takes, including
  // its retry for "the target isn't up yet".
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[window] Renderer process gone (${details.reason}), reloading`, details);
    if (!win.isDestroyed()) {
      void loadWebApp(win, managed);
    }
  });

  void loadWebApp(win, managed);

  return win;
}
