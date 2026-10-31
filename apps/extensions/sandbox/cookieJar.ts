/**
 * The cookies a sandboxed source's requests carry, held by the trusted parent.
 *
 * A source behind Cloudflare (or a login) needs the cookies a real browser earned, but the
 * sandboxed child must never see them: a hostile bundle could read and exfiltrate a session
 * through any allowlisted host. So the jar lives here, beside the fetch proxy. The proxy
 * adds the matching `Cookie` header to each outbound request and feeds `Set-Cookie` back
 * into the jar, and the child only ever sees responses with `Set-Cookie` removed.
 *
 * Matching follows RFC 6265 closely enough for scraping: host-only vs domain cookies,
 * path prefixes, `Secure`, and expiry. Like a browser, it refuses a cookie scoped to a
 * public suffix (`com`, `co.uk`, `github.io`): one source's allowlist can hold two
 * unrelated sites under the same suffix, and such a cookie would be sent to both.
 */
import { getPublicSuffix } from 'tldts';

export interface StoredCookie {
  name: string;
  value: string;
  /** Lower-case, without a leading dot. */
  domain: string;
  /** True when the cookie had no Domain attribute: it matches `domain` exactly and no
   * subdomain. */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; undefined for a session cookie. */
  expires?: number;
}

/** What the jar needs from its owner: the cookies to start with, and somewhere to report
 * changes so they can be persisted. Supplied by the caller because this package cannot
 * import server code. */
export interface SandboxBrowserSession {
  /** Cookie and User-Agent headers for a request to `url`, or null for none. Only called
   * for URLs that already passed the source's host allowlist. */
  headersFor(url: URL): Promise<SandboxSessionHeaders | null> | SandboxSessionHeaders | null;
  /** `Set-Cookie` values a response from `url` carried. */
  receiveSetCookies(url: URL, setCookies: string[]): Promise<void> | void;
}

export interface SandboxSessionHeaders {
  cookie?: string;
  userAgent?: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^\.+/, '').toLowerCase();
}

/**
 * Whether `domain` is a public suffix: a name under which unrelated sites register, so no
 * cookie may be scoped to it. Includes private suffixes (`github.io`), as browsers do.
 */
export function isPublicSuffix(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized.includes('.')) return true;
  return getPublicSuffix(normalized, { allowPrivateDomains: true }) === normalized;
}

/** RFC 6265 §5.1.3. */
export function domainMatches(
  hostname: string,
  cookie: Pick<StoredCookie, 'domain' | 'hostOnly'>,
): boolean {
  const host = hostname.toLowerCase();
  if (host === cookie.domain) return true;
  return !cookie.hostOnly && host.endsWith(`.${cookie.domain}`);
}

/** RFC 6265 §5.1.4. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/** RFC 6265 §5.1.4's default-path. */
function defaultPath(url: URL): string {
  const pathname = url.pathname;
  if (!pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function isExpired(cookie: StoredCookie, at = nowSeconds()): boolean {
  return cookie.expires !== undefined && cookie.expires <= at;
}

/**
 * Parses one `Set-Cookie` value received from `url`, or returns null when the cookie must
 * be ignored (malformed, or a Domain attribute the responding host may not set).
 */
export function parseSetCookie(header: string, url: URL): StoredCookie | null {
  const [pair, ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  const host = url.hostname.toLowerCase();
  const cookie: StoredCookie = {
    name,
    value,
    domain: host,
    hostOnly: true,
    path: defaultPath(url),
    secure: false,
    httpOnly: false,
  };
  let maxAge: number | undefined;
  let expires: number | undefined;

  for (const attribute of attributes) {
    const sep = attribute.indexOf('=');
    const key = (sep === -1 ? attribute : attribute.slice(0, sep)).trim().toLowerCase();
    const attrValue = sep === -1 ? '' : attribute.slice(sep + 1).trim();
    switch (key) {
      case 'domain': {
        const domain = normalizeDomain(attrValue);
        if (!domain) break;
        // A host may only set cookies for itself or a parent domain of itself, and never
        // for a public suffix (RFC 6265 §5.3 step 5). A host that is itself a suffix
        // (a site at the root of a private suffix) keeps the cookie to itself.
        if (host !== domain && !host.endsWith(`.${domain}`)) return null;
        if (isPublicSuffix(domain)) {
          if (domain !== host) return null;
          break;
        }
        cookie.domain = domain;
        cookie.hostOnly = false;
        break;
      }
      case 'path':
        if (attrValue.startsWith('/')) cookie.path = attrValue;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'max-age': {
        const seconds = Number(attrValue);
        if (Number.isInteger(seconds)) maxAge = seconds;
        break;
      }
      case 'expires': {
        const ms = Date.parse(attrValue);
        if (Number.isFinite(ms)) expires = Math.floor(ms / 1000);
        break;
      }
    }
  }

  // Max-Age wins over Expires (RFC 6265 §5.3 step 3).
  if (maxAge !== undefined) cookie.expires = nowSeconds() + maxAge;
  else if (expires !== undefined) cookie.expires = expires;
  return cookie;
}

/** Bounds on what one source's jar may hold, so a host spraying `Set-Cookie` cannot grow
 * the parent's memory (or the stored session) without limit. */
const MAX_COOKIES = 300;
const MAX_COOKIE_BYTES = 8192;

export class CookieJar {
  private cookies: StoredCookie[];

  constructor(cookies: StoredCookie[] = []) {
    this.cookies = [];
    for (const cookie of cookies) this.put(cookie);
  }

  /** Stores (or, when already expired, deletes) a cookie, replacing any with the same
   * name, domain and path. Returns true when the jar changed. */
  put(cookie: StoredCookie): boolean {
    if (cookie.name.length + cookie.value.length > MAX_COOKIE_BYTES) return false;
    const normalized = { ...cookie, domain: normalizeDomain(cookie.domain) };
    const index = this.cookies.findIndex(
      (existing) =>
        existing.name === normalized.name &&
        existing.domain === normalized.domain &&
        existing.path === normalized.path,
    );
    if (isExpired(normalized)) {
      if (index === -1) return false;
      this.cookies.splice(index, 1);
      return true;
    }
    if (index !== -1) {
      this.cookies[index] = normalized;
    } else {
      if (this.cookies.length >= MAX_COOKIES) this.cookies.shift();
      this.cookies.push(normalized);
    }
    return true;
  }

  /** Applies `Set-Cookie` values received from `url`. Returns true when the jar changed. */
  setCookies(url: URL, headers: string[]): boolean {
    let changed = false;
    for (const header of headers) {
      const cookie = parseSetCookie(header, url);
      if (cookie && this.put(cookie)) changed = true;
    }
    return changed;
  }

  /** The `Cookie` header value for a request to `url`, or undefined when nothing
   * matches. Longer paths first, as browsers send them. */
  cookieHeader(url: URL): string | undefined {
    const at = nowSeconds();
    const matching = this.cookies
      .filter(
        (cookie) =>
          !isExpired(cookie, at) &&
          domainMatches(url.hostname, cookie) &&
          pathMatches(url.pathname || '/', cookie.path) &&
          (!cookie.secure || url.protocol === 'https:'),
      )
      .sort((left, right) => right.path.length - left.path.length);
    if (matching.length === 0) return undefined;
    return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  /** Unexpired cookies, for persisting. */
  toJSON(): StoredCookie[] {
    const at = nowSeconds();
    return this.cookies.filter((cookie) => !isExpired(cookie, at)).map((cookie) => ({ ...cookie }));
  }
}

/**
 * Cloudflare's interstitial ("Just a moment…", a managed challenge or Turnstile) as seen
 * by a non-browser client. Header first: `cf-mitigated: challenge` is what Cloudflare sets
 * on exactly these responses. The body markers are a fallback for older challenge pages,
 * and only count on a 403/503 served by Cloudflare, so an ordinary page that happens to
 * mention "just a moment" is never mistaken for one.
 */
export function isCloudflareChallenge(
  status: number,
  headers: Headers,
  bodySnippet: string,
): boolean {
  if (headers.get('cf-mitigated')?.toLowerCase() === 'challenge') return true;
  if (status !== 403 && status !== 503) return false;
  const server = headers.get('server')?.toLowerCase() ?? '';
  if (!server.includes('cloudflare')) return false;
  return /<title>\s*just a moment|cf-browser-verification|__cf_chl_|challenge-platform/i.test(
    bodySnippet,
  );
}
