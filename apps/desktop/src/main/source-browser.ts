/**
 * A plain browser window for one source's website, so the user can pass a Cloudflare
 * challenge or log in, after which the cookies it earned are handed to the local server.
 *
 * The window is deliberately not the app: no preload, context isolation and the renderer
 * sandbox on, its own persistent partition per source (never the app's session), no
 * permissions, no downloads and no popups. When it closes, the partition's cookies for the
 * source's allowed hosts and the window's User-Agent go to the server's admin-only
 * `PUT /source/:id/browser-session`, which encrypts them; the sandbox then adds them to
 * that source's requests. Cookies never pass through the app's renderer.
 *
 * Only for a server on this machine: Cloudflare ties its clearance to the IP (and
 * User-Agent) that passed the challenge, and the cookies are secrets.
 */
import { app, BrowserWindow, session as electronSession } from 'electron';
import { resolveApiUrl } from '../shared/config';
import {
  acceptLanguages,
  browserUserAgent,
  cookiesForAllowedHosts,
  isHostAllowed,
  isLoopbackApi,
  partitionFor,
  startUrlFor,
} from './source-browser-policy';

export interface SourceBrowserResult {
  /** True when cookies were captured and the server stored them. */
  saved: boolean;
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

async function runWindow(source: InstalledSourceInfo): Promise<SourceBrowserResult> {
  const startUrl = startUrlFor(source.base_url, source.allowed_hosts);
  const partition = partitionFor(source.source_key);
  const ses = electronSession.fromPartition(partition);
  const userAgent = browserUserAgent(ses.getUserAgent());
  ses.setUserAgent(userAgent, acceptLanguages(app.getPreferredSystemLanguages()));
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    title: `${source.name} — pass the check or sign in, then close this window`,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      // Deliberately no preload: this window shows a third-party site and must have no
      // bridge to the app.
    },
  });
  windowsBySource.set(source.source_key, win);
  hardenWindow(win, source.allowed_hosts);

  const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()));
  void win.loadURL(startUrl, { userAgent }).catch(() => {
    // A failed load leaves the error page up; closing the window still saves whatever
    // the partition holds.
  });
  await closed;
  windowsBySource.delete(source.source_key);

  await ses.cookies.flushStore().catch(() => {});
  const cookies = cookiesForAllowedHosts(await ses.cookies.get({}), source.allowed_hosts);
  if (cookies.length === 0) {
    return {
      saved: false,
      cookieCount: 0,
      message: `No cookies for ${source.name} were set, so nothing was saved.`,
    };
  }
  await callApi(`/source/${encodeURIComponent(source.source_key)}/browser-session`, {
    method: 'PUT',
    body: JSON.stringify({ userAgent, cookies }),
  });
  return {
    saved: true,
    cookieCount: cookies.length,
    message: `Saved the browser session for ${source.name}.`,
  };
}

/**
 * Opens (or focuses) the source's browser window and resolves once it is closed and its
 * cookies are stored. `sourceId` has already been validated at the IPC boundary.
 */
export function openSourceBrowser(sourceId: string): Promise<SourceBrowserResult> {
  const existing = windowsBySource.get(sourceId);
  const pending = openWindows.get(sourceId);
  if (pending) {
    if (existing && !existing.isDestroyed()) existing.focus();
    return pending;
  }

  const run = (async () => {
    if (!isLoopbackApi(resolveApiUrl())) {
      throw new Error(
        'Opening a source in the browser only works when the server runs on this computer.',
      );
    }
    return runWindow(await lookUpSource(sourceId));
  })().finally(() => openWindows.delete(sourceId));
  openWindows.set(sourceId, run);
  return run;
}
