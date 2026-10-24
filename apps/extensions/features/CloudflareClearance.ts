import { getLogger } from './DetectionLogger.js';

type SetCookieHeader = string | string[] | undefined;

export interface ClearanceCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
}

interface ClearanceRecord {
  cookies: ClearanceCookie[];
  expiresAtMs: number;
  updatedAtMs: number;
}

const SESSION_COOKIE_TTL_MS = 20 * 60 * 1000;
// Deliberately capped below Cloudflare's own cf_clearance expiry (see calculateExpiryMs).
// The cookie is tied to the fingerprint and proxy IP that solved the challenge, which
// rotate faster than its lifetime, so trusting the cookie expiry would reuse stale clearances.
const MAX_CLEARANCE_TTL_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const clearanceStore = new Map<string, ClearanceRecord>();
let sweepTimer: NodeJS.Timeout | null = null;

// Reads clean up entries reactively (cleanupRecord), so a hostname/proxy pairing that is
// never looked up again would stay in memory forever. A periodic sweep bounds that. It
// starts lazily on the first stored clearance, since many processes never store any.
function ensureSweepTimerStarted(): void {
  if (sweepTimer) {
    return;
  }

  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of clearanceStore) {
      if (now > record.expiresAtMs || getUnexpiredCookies(record).length === 0) {
        clearanceStore.delete(key);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function isCloudflareCookie(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'cf_clearance' || lower === '_cfuvid';
}

function normalizeDomain(domain: string, fallbackHost: string): string {
  const normalized = domain.trim().replace(/^\./, '');
  return normalized || fallbackHost;
}

function domainMatches(host: string, cookieDomain: string): boolean {
  return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
}

function getKey(targetUrl: string, proxyUrl?: string | null): string {
  const parsed = new URL(targetUrl);
  return `${parsed.protocol}//${parsed.hostname}|${proxyUrl || 'direct'}`;
}

function getUnexpiredCookies(record: ClearanceRecord): ClearanceCookie[] {
  const nowSec = Date.now() / 1000;
  return record.cookies.filter((cookie) => !cookie.expires || cookie.expires > nowSec);
}

function cleanupRecord(key: string): ClearanceRecord | null {
  const existing = clearanceStore.get(key);
  if (!existing) {
    return null;
  }

  if (Date.now() > existing.expiresAtMs) {
    clearanceStore.delete(key);
    return null;
  }

  const cookies = getUnexpiredCookies(existing);
  if (cookies.length === 0) {
    clearanceStore.delete(key);
    return null;
  }

  if (cookies.length !== existing.cookies.length) {
    const next = {
      ...existing,
      cookies,
    };
    clearanceStore.set(key, next);
    return next;
  }

  return existing;
}

function mergeCookies(existing: ClearanceCookie[], incoming: ClearanceCookie[]): ClearanceCookie[] {
  const map = new Map<string, ClearanceCookie>();

  for (const cookie of existing) {
    const identity = `${cookie.name}|${cookie.domain}|${cookie.path}`;
    map.set(identity, cookie);
  }

  for (const cookie of incoming) {
    const identity = `${cookie.name}|${cookie.domain}|${cookie.path}`;
    map.set(identity, cookie);
  }

  return Array.from(map.values());
}

// Capped at MAX_CLEARANCE_TTL_MS even when the cookie's own expiry is later.
function calculateExpiryMs(cookies: ClearanceCookie[]): number {
  const now = Date.now();
  const expiriesMs = cookies
    .map((cookie) => (cookie.expires && cookie.expires > 0 ? cookie.expires * 1000 : null))
    .filter((value): value is number => value !== null);

  const earliest = expiriesMs.length > 0 ? Math.min(...expiriesMs) : now + SESSION_COOKIE_TTL_MS;
  return Math.min(earliest, now + MAX_CLEARANCE_TTL_MS);
}

function saveCookies(
  targetUrl: string,
  cookies: ClearanceCookie[],
  proxyUrl?: string | null,
): boolean {
  if (cookies.length === 0) {
    return false;
  }

  const key = getKey(targetUrl, proxyUrl);
  const previous = cleanupRecord(key);
  const merged = mergeCookies(previous?.cookies || [], cookies);
  const hasClearance = merged.some((cookie) => cookie.name.toLowerCase() === 'cf_clearance');
  if (!hasClearance) {
    clearanceStore.delete(key);
    return false;
  }

  const expiresAtMs = calculateExpiryMs(merged);

  clearanceStore.set(key, {
    cookies: merged,
    expiresAtMs,
    updatedAtMs: Date.now(),
  });
  ensureSweepTimerStarted();

  return true;
}

function parseSetCookie(header: string, fallbackHost: string): ClearanceCookie | null {
  const segments = header.split(';').map((segment) => segment.trim());
  if (segments.length === 0) {
    return null;
  }

  const [cookiePair, ...attributes] = segments;
  const eqIndex = cookiePair.indexOf('=');
  if (eqIndex <= 0) {
    return null;
  }

  const name = cookiePair.slice(0, eqIndex).trim();
  const value = cookiePair.slice(eqIndex + 1).trim();
  if (!name || !value || !isCloudflareCookie(name)) {
    return null;
  }

  let domain = fallbackHost;
  let path = '/';
  let expires: number | undefined;
  let secure: boolean | undefined;
  let httpOnly: boolean | undefined;

  for (const attribute of attributes) {
    const lower = attribute.toLowerCase();

    if (lower.startsWith('domain=')) {
      domain = normalizeDomain(attribute.slice(7), fallbackHost);
      continue;
    }

    if (lower.startsWith('path=')) {
      path = attribute.slice(5).trim() || '/';
      continue;
    }

    if (lower.startsWith('max-age=')) {
      const maxAgeSec = Number.parseInt(attribute.slice(8), 10);
      if (Number.isFinite(maxAgeSec)) {
        expires = Math.floor(Date.now() / 1000) + Math.max(0, maxAgeSec);
      }
      continue;
    }

    if (lower.startsWith('expires=')) {
      const timestamp = Date.parse(attribute.slice(8).trim());
      if (!Number.isNaN(timestamp)) {
        expires = Math.floor(timestamp / 1000);
      }
      continue;
    }

    if (lower === 'secure') {
      secure = true;
      continue;
    }

    if (lower === 'httponly') {
      httpOnly = true;
    }
  }

  return {
    name,
    value,
    domain: normalizeDomain(domain, fallbackHost),
    path,
    expires,
    secure,
    httpOnly,
  };
}

export function updateCloudflareClearanceFromBrowserCookies(
  targetUrl: string,
  cookies: ClearanceCookie[],
  proxyUrl?: string | null,
): boolean {
  const targetHost = new URL(targetUrl).hostname;
  const cloudflareCookies = cookies
    .filter((cookie) => isCloudflareCookie(cookie.name))
    .map((cookie) => ({
      ...cookie,
      domain: normalizeDomain(cookie.domain || targetHost, targetHost),
      path: cookie.path || '/',
    }));

  const stored = saveCookies(targetUrl, cloudflareCookies, proxyUrl);
  if (stored) {
    getLogger().debug('[CloudflareClearance] Stored cf_clearance from browser cookies', {
      targetUrl,
      proxyUrl: proxyUrl || 'direct',
    });
  }
  return stored;
}

export function updateCloudflareClearanceFromSetCookie(
  targetUrl: string,
  setCookieHeader: SetCookieHeader,
  proxyUrl?: string | null,
): boolean {
  if (!setCookieHeader) {
    return false;
  }

  const targetHost = new URL(targetUrl).hostname;
  const rawHeaders = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const parsed = rawHeaders
    .map((header) => parseSetCookie(header, targetHost))
    .filter((cookie): cookie is ClearanceCookie => cookie !== null);

  const stored = saveCookies(targetUrl, parsed, proxyUrl);
  if (stored) {
    getLogger().debug('[CloudflareClearance] Stored cf_clearance from set-cookie', {
      targetUrl,
      proxyUrl: proxyUrl || 'direct',
    });
  }
  return stored;
}

export function getCloudflareCookieHeader(
  targetUrl: string,
  proxyUrl?: string | null,
): string | null {
  const key = getKey(targetUrl, proxyUrl);
  const record = cleanupRecord(key);
  if (!record) {
    return null;
  }

  const host = new URL(targetUrl).hostname;
  const cookies = getUnexpiredCookies(record).filter((cookie) =>
    domainMatches(host, cookie.domain),
  );
  if (cookies.length === 0) {
    return null;
  }

  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export function getCloudflareCookiesForBrowser(
  targetUrl: string,
  proxyUrl?: string | null,
): ClearanceCookie[] {
  const key = getKey(targetUrl, proxyUrl);
  const record = cleanupRecord(key);
  if (!record) {
    return [];
  }

  const host = new URL(targetUrl).hostname;
  return getUnexpiredCookies(record).filter((cookie) => domainMatches(host, cookie.domain));
}

export function clearCloudflareClearance(targetUrl: string, proxyUrl?: string | null): void {
  clearanceStore.delete(getKey(targetUrl, proxyUrl));
}
