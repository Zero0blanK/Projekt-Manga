import {
  CookieJar,
  domainMatches,
  isPublicSuffix,
  type SandboxBrowserSession,
  type StoredCookie,
} from '@projekt-manga/extensions/sandbox';
import type { SourceBrowserSessionBody } from '@projekt-manga/schemas';
import type { SourceBrowserSessionStatus } from '@projekt-manga/types';
import sourceBrowserSessionRepository from '../repositories/sourceBrowserSession.repository.js';
import extensionRepositoryRepository from '../repositories/extensionRepository.repository.js';
import { encryptToken, decryptToken } from '../utils/tokenCrypto.js';
import {
  AppError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../utils/customErrors.js';

/**
 * Browser sessions for sources: the cookies the desktop app's source window earned
 * (a passed Cloudflare challenge, a login) and the User-Agent that earned them.
 *
 * Held per source as a `CookieJar` in this process and handed to the sandbox as a
 * `SandboxBrowserSession`, which adds them to that source's requests in the parent so the
 * sandboxed child never sees them. Stored encrypted with TOKEN_ENCRYPTION_KEY, one row per
 * cookie domain. Cookie values never appear in a log line or a response.
 */

interface LoadedSession {
  jar: CookieJar;
  userAgent: string;
  allowedHosts: string[];
}

/** One entry per source that has been asked about; `null` means "no stored session". */
const sessions = new Map<string, Promise<LoadedSession | null>>();
const persistTimers = new Map<string, NodeJS.Timeout>();
/** Writes of refreshed cookies still in flight: a load, a save or a clear waits for them,
 * so it never reads the database before them or is overwritten by them. */
const pendingWrites = new Map<string, Promise<void>>();

/** Coalesces a burst of Set-Cookie responses (a catalogue page fetches many) into one write. */
const PERSIST_DELAY_MS = 2000;

/** Whether a cookie would be sent to one of the source's allowed hosts, or a subdomain of
 * one — the only requests the sandbox ever makes. A domain cookie scoped to a public
 * suffix ("com", "co.uk") is never kept: no browser stores one, and it would reach every
 * allowlisted site under that suffix. */
function cookieServesAllowedHost(cookie: StoredCookie, allowedHosts: readonly string[]): boolean {
  if (!cookie.hostOnly && isPublicSuffix(cookie.domain)) return false;
  if (!cookie.domain.includes('.')) return false;
  return allowedHosts.some(
    (allowed) =>
      domainMatches(allowed, cookie) ||
      cookie.domain === allowed ||
      cookie.domain.endsWith(`.${allowed}`),
  );
}

function groupByDomain(cookies: StoredCookie[]): Map<string, StoredCookie[]> {
  const groups = new Map<string, StoredCookie[]>();
  for (const cookie of cookies) {
    const group = groups.get(cookie.domain) ?? [];
    group.push(cookie);
    groups.set(cookie.domain, group);
  }
  return groups;
}

/** Encrypts, mapping the key's absence onto a message about this feature rather than
 * tokenCrypto's tracker-specific one. */
function encryptCookies(cookies: StoredCookie[]): string {
  try {
    return encryptToken(JSON.stringify(cookies));
  } catch (error) {
    if (error instanceof AppError) {
      throw new ServiceUnavailableError(
        'This server has no TOKEN_ENCRYPTION_KEY, so it cannot store browser sessions for sources',
      );
    }
    throw error;
  }
}

async function getAllowedHosts(sourceKey: string): Promise<string[] | null> {
  const rows = await extensionRepositoryRepository.getInstalledExtensions();
  const row = rows.find((candidate) => candidate.source_key === sourceKey && candidate.enabled);
  if (!row) return null;
  return Array.isArray(row.allowed_hosts) ? (row.allowed_hosts as string[]) : [];
}

async function loadSession(sourceKey: string): Promise<LoadedSession | null> {
  const rows = await sourceBrowserSessionRepository.getForSource(sourceKey);
  if (rows.length === 0) return null;
  const allowedHosts = await getAllowedHosts(sourceKey);
  if (!allowedHosts) return null;

  const cookies: StoredCookie[] = [];
  for (const row of rows) {
    try {
      cookies.push(...(JSON.parse(decryptToken(row.cookies_encrypted)) as StoredCookie[]));
    } catch {
      // A changed or missing key makes the row unreadable. Skipped, not thrown: the source
      // still works without it, just as if no browser session had been saved.
      console.warn(
        `[Source Browser] Could not decrypt the stored browser session for "${sourceKey}" (${row.host}); ignoring it`,
      );
    }
  }
  if (cookies.length === 0) return null;
  return {
    jar: new CookieJar(cookies.filter((cookie) => cookieServesAllowedHost(cookie, allowedHosts))),
    userAgent: rows[0].user_agent,
    allowedHosts,
  };
}

function getSession(sourceKey: string): Promise<LoadedSession | null> {
  let session = sessions.get(sourceKey);
  if (!session) {
    const loading = async () => {
      await pendingWrites.get(sourceKey);
      return loadSession(sourceKey);
    };
    session = loading().catch((error: unknown) => {
      sessions.delete(sourceKey);
      console.warn(
        `[Source Browser] Could not load the browser session for "${sourceKey}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    });
    sessions.set(sourceKey, session);
  }
  return session;
}

async function writeSession(sourceKey: string, session: LoadedSession): Promise<void> {
  const cookies = session.jar
    .toJSON()
    .filter((cookie) => cookieServesAllowedHost(cookie, session.allowedHosts));
  const rows = [...groupByDomain(cookies)].map(([host, group]) => ({
    host,
    cookies_encrypted: encryptCookies(group),
    user_agent: session.userAgent,
  }));
  await sourceBrowserSessionRepository.replaceForSource(sourceKey, rows);
}

function schedulePersist(sourceKey: string, session: LoadedSession): void {
  if (persistTimers.has(sourceKey)) return;
  const timer = setTimeout(() => {
    persistTimers.delete(sourceKey);
    // Only if the session is still the current one: a clear or a fresh capture since
    // then must not be overwritten by the jar it replaced.
    void sessions.get(sourceKey)?.then(async (current) => {
      if (current !== session) return;
      try {
        await writeSession(sourceKey, session);
      } catch (error) {
        console.warn(
          `[Source Browser] Could not save refreshed cookies for "${sourceKey}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }, PERSIST_DELAY_MS);
  timer.unref?.();
  persistTimers.set(sourceKey, timer);
}

/** The sandbox's view of a source's browser session. Requests get nothing until the
 * desktop app has saved one; after that, refreshed cookies (Cloudflare reissues its
 * clearance) are kept and written back. */
export function browserSessionFor(sourceKey: string): SandboxBrowserSession {
  return {
    async headersFor(url) {
      const session = await getSession(sourceKey);
      if (!session) return null;
      return { cookie: session.jar.cookieHeader(url), userAgent: session.userAgent };
    },
    async receiveSetCookies(url, setCookies) {
      const session = await getSession(sourceKey);
      if (!session) return;
      if (session.jar.setCookies(url, setCookies)) schedulePersist(sourceKey, session);
    },
  };
}

/** The saved session's cookie and User-Agent for an image on the source's own site (a
 * cover, a page), which sits behind the same Cloudflare check as its pages. Nothing for
 * any other host, or when no session is saved. */
export async function imageSessionHeaders(
  sourceKey: string,
  url: URL,
): Promise<Record<string, string>> {
  const session = await getSession(sourceKey);
  if (
    !session ||
    !session.allowedHosts.some(
      (allowed) => url.hostname === allowed || url.hostname.endsWith(`.${allowed}`),
    )
  )
    return {};
  const cookie = session.jar.cookieHeader(url);
  return cookie ? { Cookie: cookie, 'User-Agent': session.userAgent } : {};
}

function cancelPendingPersist(sourceKey: string): void {
  const timer = persistTimers.get(sourceKey);
  if (timer) clearTimeout(timer);
  persistTimers.delete(sourceKey);
}

/** Writes refreshed cookies waiting on the persist timer now, instead of dropping them. */
function flushPendingPersist(sourceKey: string): void {
  if (!persistTimers.has(sourceKey)) return;
  cancelPendingPersist(sourceKey);
  const current = sessions.get(sourceKey);
  if (!current) return;
  const write = current
    .then((session) => (session ? writeSession(sourceKey, session) : undefined))
    .catch((error: unknown) => {
      console.warn(
        `[Source Browser] Could not save refreshed cookies for "${sourceKey}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      if (pendingWrites.get(sourceKey) === write) pendingWrites.delete(sourceKey);
    });
  pendingWrites.set(sourceKey, write);
}

async function getStatus(sourceKey: string): Promise<SourceBrowserSessionStatus> {
  const rows = await sourceBrowserSessionRepository.getForSource(sourceKey);
  const updatedAt = rows.reduce<Date | null>(
    (latest, row) => (!latest || row.updated_at > latest ? row.updated_at : latest),
    null,
  );
  const session = await getSession(sourceKey);
  return {
    sourceId: sourceKey,
    hosts: rows.map((row) => row.host).sort(),
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    userAgent: session?.userAgent ?? null,
    cookies: (session?.jar.toJSON() ?? []).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      expires: cookie.expires ?? null,
    })),
  };
}

/**
 * Replaces the source's session with what the desktop app captured or the reader pasted.
 * Cookies for hosts outside the source's allowlist are dropped here — the partition also
 * holds whatever third-party sites the page loaded, and those have no business being
 * stored. A body without cookies changes only the User-Agent.
 */
async function saveSession(
  sourceKey: string,
  body: SourceBrowserSessionBody,
): Promise<SourceBrowserSessionStatus> {
  const allowedHosts = await getAllowedHosts(sourceKey);
  if (!allowedHosts) {
    throw new NotFoundError(`Source not found: ${sourceKey}`);
  }

  // Without cookies only the User-Agent changes: the stored cookies are kept.
  const kept = body.cookies ? null : await getSession(sourceKey);
  if (!body.cookies && !kept) {
    throw new ValidationError('There is no saved session to change; paste the cookie too');
  }
  const jar = new CookieJar(
    (body.cookies ?? [])
      .map((cookie): StoredCookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain.replace(/^\.+/, '').toLowerCase(),
        hostOnly: cookie.hostOnly,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(cookie.expires !== undefined ? { expires: Math.floor(cookie.expires) } : {}),
      }))
      .filter((cookie) => cookieServesAllowedHost(cookie, allowedHosts))
      .concat(kept?.jar.toJSON() ?? []),
  );
  const session: LoadedSession = { jar, userAgent: body.userAgent, allowedHosts };

  cancelPendingPersist(sourceKey);
  await pendingWrites.get(sourceKey);
  await writeSession(sourceKey, session);
  sessions.set(sourceKey, Promise.resolve(jar.toJSON().length > 0 ? session : null));
  return getStatus(sourceKey);
}

async function clearSession(sourceKey: string): Promise<void> {
  cancelPendingPersist(sourceKey);
  sessions.set(sourceKey, Promise.resolve(null));
  await pendingWrites.get(sourceKey);
  await sourceBrowserSessionRepository.deleteForSource(sourceKey);
}

/** Forgets cached sessions (one source's, or all), so the next request reloads from the
 * database. Called when a source is respawned, since an update can change its allowlist.
 * Refreshed cookies not yet saved are written first (the reload waits for them); the
 * reload filters them by the new allowlist. */
export function forgetBrowserSessions(sourceKey?: string): void {
  for (const key of sourceKey === undefined ? [...persistTimers.keys()] : [sourceKey])
    flushPendingPersist(key);
  if (sourceKey !== undefined) sessions.delete(sourceKey);
  else sessions.clear();
}

const sourceBrowserSessionService = {
  getStatus,
  saveSession,
  clearSession,
};

export default sourceBrowserSessionService;
