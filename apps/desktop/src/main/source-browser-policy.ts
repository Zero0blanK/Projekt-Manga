/**
 * The decisions behind the source browser window (main/source-browser.ts), kept free of
 * Electron imports so tests can exercise them directly.
 */

/** Source keys are short slugs; anything else is refused before it reaches a URL or a
 * partition name. */
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseOpenBrowserArgs(args: unknown): { sourceId: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('openBrowser expects { sourceId }');
  }
  const { sourceId } = args as { sourceId?: unknown };
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) {
    throw new Error('sourceId must be a source key');
  }
  return { sourceId };
}

/** One persistent partition per source, so a login on one source never shows up in
 * another's window and none of them touch the app's own session. */
export function partitionFor(sourceId: string): string {
  return `persist:source-browser-${sourceId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
}

export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Whether the API is on this machine. Cloudflare ties its clearance to the IP that
 * passed the challenge, and the cookies are secrets, so they only go to a local server. */
export function isLoopbackApi(apiUrl: string): boolean {
  try {
    const { hostname } = new URL(apiUrl);
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '[::1]' ||
      /^127\.\d+\.\d+\.\d+$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/** The page the window opens: the source's own site, and only when that site is one the
 * source may reach — a listing whose base_url points elsewhere gets no window. */
export function startUrlFor(baseUrl: string, allowedHosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('This source has no usable website address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('This source has no usable website address');
  }
  if (!isHostAllowed(url.hostname, allowedHosts)) {
    throw new Error("This source's website is not one it is allowed to reach");
  }
  return url.href;
}

/** Electron's default User-Agent names Electron and the app, which challenge pages treat
 * as a bot. Without them it is the plain Chromium string the window really is. */
export function browserUserAgent(defaultUserAgent: string): string {
  return defaultUserAgent
    .replace(/\s+Electron\/\S+/gi, '')
    .replace(/\s+projekt[-_ ]?manga\S*\/\S+/gi, '')
    .trim();
}

/**
 * The languages for the window's Accept-Language header: the system's preferred languages,
 * which are also what the page's `navigator.languages` lists. Electron otherwise sends only
 * the app locale, and site checks treat that disagreement as a sign of automation. Electron
 * adds the quality weights itself, so the list carries none ("en-US,ja" is sent as
 * "en-US,ja;q=0.9").
 */
export function acceptLanguages(preferred: readonly string[]): string {
  const tags: string[] = [];
  for (const raw of preferred) {
    const tag = raw.trim().replace('_', '-');
    if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return (tags.length ? tags : ['en-US']).slice(0, 10).join(',');
}

/** The subset of Electron's `Cookie` this reads. */
export interface PartitionCookie {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
}

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
}

/**
 * The partition's cookies that the source's requests would carry: those for an allowed
 * host, a subdomain of one, or a parent domain of one (Cloudflare sets its clearance on
 * the registrable domain). Third-party cookies the page picked up are left behind.
 */
export function cookiesForAllowedHosts(
  cookies: readonly PartitionCookie[],
  allowedHosts: readonly string[],
): SessionCookie[] {
  const kept: SessionCookie[] = [];
  for (const cookie of cookies) {
    const domain = (cookie.domain ?? '').replace(/^\.+/, '').toLowerCase();
    if (!domain.includes('.') || !cookie.name) continue;
    // The server's limits (sourceBrowserSessionBodySchema): one oversized cookie must
    // not cost the whole session.
    if (cookie.name.length > 256 || cookie.value.length > 4096 || domain.length > 253) continue;
    if (kept.length >= 300) break;
    const serves = allowedHosts.some(
      (allowed) =>
        allowed === domain || allowed.endsWith(`.${domain}`) || domain.endsWith(`.${allowed}`),
    );
    if (!serves) continue;
    kept.push({
      name: cookie.name,
      value: cookie.value,
      domain,
      hostOnly: cookie.hostOnly ?? false,
      path: cookie.path || '/',
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
      ...(!cookie.session && cookie.expirationDate ? { expires: cookie.expirationDate } : {}),
    });
  }
  return kept;
}
