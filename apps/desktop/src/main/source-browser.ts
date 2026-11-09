/**
 * A plain browser window for one source's website, so a Cloudflare challenge or login can
 * be passed, after which the cookies it earned are handed to the local server. A check the
 * app opens by itself runs hidden, as Mihon's does; the visible window is for the reader's
 * own "Open in browser", where they can finish a click or CAPTCHA.
 *
 * The window is deliberately not the app: no preload, context isolation and the renderer
 * sandbox on, its own persistent partition per source (never the app's session), no
 * permissions, no downloads and no popups. It presents the Chrome identity of the
 * Chromium underneath (User-Agent, client hints, child frames) instead of Electron's,
 * which challenge pages treat as a bot. When it closes, the partition's cookies for the
 * source's allowed hosts and that User-Agent go to the server's admin-only
 * `PUT /source/:id/browser-session`, which encrypts them; the sandbox then adds them to
 * that source's requests. Cookies never pass through the app's renderer.
 *
 * Only for a server on this machine: Cloudflare ties its clearance to the IP (and
 * User-Agent) that passed the challenge, and the cookies are secrets.
 */
import { app, BrowserWindow, session as electronSession } from 'electron';
import { resolveApiUrl } from '../shared/config';
import {
  applyBrowserIdentityHeaders,
  browserIdentity,
  cookiesForAllowedHosts,
  isChallengeTitle,
  isHostAllowed,
  isLoopbackApi,
  partitionFor,
  startUrlFor,
  type BrowserIdentity,
} from './source-browser-policy';

export interface SourceBrowserResult {
  /** True when cookies were captured and the server stored them. */
  saved: boolean;
  /**
   * True when the site was seen past its check: it closed by itself showing the source's
   * own page, or it left a clearance cookie. A window closed with the check still up may
   * have saved other cookies, but nothing that gets the app past the check.
   */
  passed: boolean;
  /** How many cookies were sent (never their values). */
  cookieCount: number;
  message: string;
}

interface InstalledSourceInfo {
  source_key: string;
  name: string;
  base_url: string;
  allowed_hosts: string[];
  enabled: boolean;
}

const openWindows = new Map<string, Promise<SourceBrowserResult>>();
const windowsBySource = new Map<string, BrowserWindow>();

async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${resolveApiUrl().replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const envelope = (await res.json().catch(() => null)) as {
    success?: boolean;
    message?: string;
    data?: T;
  } | null;
  if (!res.ok || !envelope?.success) {
    throw new Error(envelope?.message || `The server answered ${res.status}`);
  }
  return envelope.data as T;
}

/** The source's site and allowlist come from the server, never from the renderer. */
async function lookUpSource(sourceId: string): Promise<InstalledSourceInfo> {
  const installed = await callApi<InstalledSourceInfo[]>('/extensions/installed');
  const source = installed.find((row) => row.source_key === sourceId && row.enabled);
  if (!source) throw new Error('This source is not installed');
  return {
    ...source,
    allowed_hosts: Array.isArray(source.allowed_hosts)
      ? source.allowed_hosts.filter((host): host is string => typeof host === 'string')
      : [],
  };
}

function hardenWindow(win: BrowserWindow, allowedHosts: readonly string[]): void {
  const contents = win.webContents;
  // Popups (a login provider's window, an ad) navigate this window instead, and only to
  // web pages: no file:, no custom protocols.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void win.loadURL(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:/i.test(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  // A login may pass through other hosts (an identity provider), so navigation is not
  // pinned to the allowlist; the title says which site is showing.
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    let host = '';
    try {
      host = new URL(contents.getURL()).hostname;
    } catch {
      // keep the bare title
    }
    const marker = host && !isHostAllowed(host, allowedHosts) ? ' (other site)' : '';
    win.setTitle(host ? `${title} — ${host}${marker}` : title);
  });
}

/** A check the app runs by itself stays hidden for this long; if it has not passed by then
 * (it needs a click or CAPTCHA), the same window is shown so the reader can finish it. */
const HIDDEN_ATTEMPT_MS = 20_000;

/** Navigator.webdriver is already false in Electron, but a challenge script may look for
 * the property on the prototype. */
const WEBDRIVER_PATCH = `(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      get: () => false,
    });
  } catch {}
})();`;

/**
 * Makes the page look like the Chrome it really is, not like Electron. The network identity
 * comes from CDP because Electron has no API for User-Agent client hints, and the
 * override follows child frames (Turnstile runs in one) as well as the top page.
 */
async function disguiseWindow(win: BrowserWindow, identity: BrowserIdentity): Promise<() => void> {
  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
  } catch {
    return () => {};
  }

  // Electron creates a new window's renderer lazily, and CDP commands sent before the
  // first navigation wait for it. Give it a throwaway document before overriding it, or
  // awaiting the override would deadlock the real navigation.
  await win.loadURL('about:blank').catch(() => {});

  const applyTo = async (sessionId?: string) => {
    await dbg
      .sendCommand(
        'Emulation.setUserAgentOverride',
        {
          userAgent: identity.userAgent,
          acceptLanguage: identity.acceptLanguage,
          platform: identity.platform,
          userAgentMetadata: identity.userAgentMetadata,
        },
        sessionId,
      )
      .catch(() => {});
    await dbg
      .sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: WEBDRIVER_PATCH }, sessionId)
      .catch(() => {});
  };

  const onMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown,
    _sessionId: string,
  ) => {
    if (method !== 'Target.attachedToTarget') return;
    const attached = params as {
      sessionId?: unknown;
      waitingForDebugger?: unknown;
    };
    const childId = typeof attached.sessionId === 'string' ? attached.sessionId : '';
    if (!childId) return;
    void (async () => {
      // The Page and Emulation domains are missing on some worker targets; each command
      // fails on its own, and the target is released either way.
      await applyTo(childId);
      if (attached.waitingForDebugger === true) {
        await dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, childId).catch(() => {});
      }
    })();
  };

  dbg.on('message', onMessage);
  await applyTo();
  // Child frames (challenges.cloudflare.com's Turnstile, for one) are separate targets
  // and would otherwise keep Electron's own identity.
  await dbg
    .sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
    .catch(() => {});

  return () => {
    dbg.removeListener('message', onMessage);
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      // Already gone with the window.
    }
  };
}

/** Rewrites identity headers for every request in the source's session, so subframes and
 * workers cannot leak Electron's User-Agent or Chromium-only client hints. */
function rewriteIdentityHeaders(ses: Electron.Session, identity: BrowserIdentity): () => void {
  const listener = (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void,
  ) => {
    const headers = { ...details.requestHeaders } as Record<string, string | string[]>;
    applyBrowserIdentityHeaders(headers, identity, /^https:/i.test(details.url));
    callback({ requestHeaders: headers });
  };
  ses.webRequest.onBeforeSendHeaders(listener);
  return () => ses.webRequest.onBeforeSendHeaders(null);
}

/** How long the site has to show itself as passed before the window closes, so a page
 * that flips between the check and the site doesn't close mid-check. */
const PASSED_SETTLE_MS = 1200;

/**
 * How long the source's own page has to stay up, with no check in sight, before a site
 * that set no clearance cookie counts as passed. Not every protected site uses
 * `cf_clearance` (DDoS-Guard, a Cloudflare rule that only sets `__cf_bm`); without this
 * the window waited out the hidden attempt and was shown, asking the reader to do
 * something that was already done.
 */
const PASSED_WITHOUT_CLEARANCE_MS = 6000;

const hasClearance = (cookies: readonly { name: string }[]) =>
  cookies.some((cookie) => cookie.name.toLowerCase() === 'cf_clearance');

/**
 * Closes the hidden window the app opened by itself once it shows the source's own site
 * rather than a browser check: at once when the site has set its clearance cookie, or once
 * the page has stayed past the check for a while when it sets none. A check that needs a
 * click or a CAPTCHA never gets there; the hidden-attempt timeout shows the same window so
 * the reader can finish it. Resolves `passed` for the caller when it closes the window.
 */
function closeWhenPassed(
  win: BrowserWindow,
  ses: Electron.Session,
  allowedHosts: readonly string[],
  onPassed: () => void,
): void {
  const contents = win.webContents;
  let timer: NodeJS.Timeout | null = null;
  /** When the page last showed something that is not the source's site past its check. */
  let challengeSeenAt = Date.now();
  const check = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (win.isDestroyed() || contents.isDestroyed()) return;
      let host: string;
      try {
        host = new URL(contents.getURL()).hostname;
      } catch {
        return;
      }
      if (!isHostAllowed(host, allowedHosts) || isChallengeTitle(contents.getTitle())) {
        challengeSeenAt = Date.now();
        return;
      }
      const cookies = cookiesForAllowedHosts(await ses.cookies.get({}), allowedHosts);
      const settled = Date.now() - challengeSeenAt >= PASSED_WITHOUT_CLEARANCE_MS;
      if (!hasClearance(cookies) && !settled) {
        check();
        return;
      }
      if (win.isDestroyed() || contents.isDestroyed()) return;
      onPassed();
      win.close();
    }, PASSED_SETTLE_MS);
  };
  contents.on('did-finish-load', check);
  contents.on('did-navigate', check);
  contents.on('page-title-updated', check);
  win.once('closed', () => {
    if (timer) clearTimeout(timer);
  });
}

async function runWindow(
  source: InstalledSourceInfo,
  options: { closeWhenPassed: boolean },
): Promise<SourceBrowserResult> {
  const startUrl = startUrlFor(source.base_url, source.allowed_hosts);
  const partition = partitionFor(source.source_key);
  const ses = electronSession.fromPartition(partition);
  const identity = browserIdentity(
    ses.getUserAgent(),
    app.getPreferredSystemLanguages(),
    process.versions.chrome,
  );
  ses.setUserAgent(identity.userAgent, identity.acceptLanguage);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());

  // A check the app runs by itself stays out of sight. A visible window is only for the
  // reader's own "Open in browser", where they can finish a click or CAPTCHA.
  const hidden = options.closeWhenPassed;
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    skipTaskbar: hidden,
    title: `${source.name} — pass the check or sign in, then close this window`,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      // Keep the check running while the window is hidden or minimized.
      backgroundThrottling: false,
      // Deliberately no preload: this window shows a third-party site and must have no
      // bridge to the app.
    },
  });
  windowsBySource.set(source.source_key, win);
  hardenWindow(win, source.allowed_hosts);
  const stopHeaders = rewriteIdentityHeaders(ses, identity);
  const stopDisguise = await disguiseWindow(win, identity);
  if (!hidden && !win.isDestroyed()) win.show();
  win.once('closed', () => {
    stopHeaders();
    stopDisguise();
  });

  let passedOnItsOwn = false;
  if (hidden) {
    const timer = setTimeout(() => {
      if (win.isDestroyed()) return;
      // The check did not pass on its own, so it needs the reader. Show the same window
      // instead of asking them to open it again.
      win.setSkipTaskbar(false);
      win.show();
      win.focus();
    }, HIDDEN_ATTEMPT_MS);
    win.once('closed', () => clearTimeout(timer));
    closeWhenPassed(win, ses, source.allowed_hosts, () => {
      passedOnItsOwn = true;
    });
  }

  const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()));
  void win.loadURL(startUrl, { userAgent: identity.userAgent }).catch(() => {
    // A failed load leaves the error page up; closing the window still saves whatever
    // the partition holds.
  });
  await closed;
  windowsBySource.delete(source.source_key);

  await ses.cookies.flushStore().catch(() => {});
  const cookies = cookiesForAllowedHosts(await ses.cookies.get({}), source.allowed_hosts);
  const passed = passedOnItsOwn || hasClearance(cookies);
  if (cookies.length === 0) {
    return {
      saved: false,
      passed,
      cookieCount: 0,
      message: `No cookies for ${source.name} were set, so nothing was saved.`,
    };
  }
  await callApi(`/source/${encodeURIComponent(source.source_key)}/browser-session`, {
    method: 'PUT',
    body: JSON.stringify({ userAgent: identity.userAgent, cookies }),
  });
  return {
    saved: true,
    passed,
    cookieCount: cookies.length,
    message: passed
      ? `Passed ${source.name}'s browser check.`
      : `Saved the browser session for ${source.name}.`,
  };
}

/**
 * Opens (or focuses) the source's browser window and resolves once it is closed and its
 * cookies are stored. `sourceId` has already been validated at the IPC boundary.
 */
export function openSourceBrowser(
  sourceId: string,
  options: { closeWhenPassed: boolean } = { closeWhenPassed: false },
): Promise<SourceBrowserResult> {
  const existing = windowsBySource.get(sourceId);
  const pending = openWindows.get(sourceId);
  if (pending) {
    if (existing && !existing.isDestroyed() && existing.isVisible()) existing.focus();
    return pending;
  }

  const run = (async () => {
    if (!isLoopbackApi(resolveApiUrl())) {
      throw new Error(
        'Opening a source in the browser only works when the server runs on this computer.',
      );
    }
    return runWindow(await lookUpSource(sourceId), options);
  })().finally(() => openWindows.delete(sourceId));
  openWindows.set(sourceId, run);
  return run;
}
