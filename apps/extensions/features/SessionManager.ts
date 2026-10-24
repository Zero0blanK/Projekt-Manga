/** Manages cookies and sessions, isolated per proxy. */

import * as fs from 'fs';
import * as path from 'path';
import { SessionConfig, BrowserFingerprint } from '../config/anon.config.js';
import { getLogger } from './DetectionLogger.js';

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface Session {
  id: string;
  proxyUrl: string | null;
  cookies: Cookie[];
  localStorage: Record<string, string>;
  createdAt: number;
  lastUsed: number;
  fingerprint: BrowserFingerprint;
  requestCount: number;
}

const DEFAULT_AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Host-vs-cookie-domain match, honouring the leading-dot subdomain convention. */
export function domainMatches(host: string, cookieDomain: string): boolean {
  const normalized = cookieDomain.trim().replace(/^\./, '').toLowerCase();
  if (!normalized) {
    return false;
  }
  const target = host.toLowerCase();
  return target === normalized || target.endsWith(`.${normalized}`);
}

/**
 * Narrow a session's cookie jar to the ones in scope for `targetUrl`.
 *
 * Sessions are keyed by proxy, not by site, so a single jar can hold cookies belonging to
 * several unrelated sources. Anything about to hand cookies to a browser context or an
 * outbound request must filter first, or a cookie set while scraping one source gets
 * replayed against another — a correctness bug and a fingerprinting signal.
 */
export function cookiesForUrl(cookies: Cookie[], targetUrl: string): Cookie[] {
  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    // An unparseable target tells us nothing about which cookies are in scope, so send
    // none rather than guessing and handing over the whole jar.
    return [];
  }
  return cookies.filter((c) => domainMatches(host, c.domain));
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private config: SessionConfig;
  private storagePath: string;
  private loaded: boolean = false;
  private autosaveTimer: NodeJS.Timeout | null = null;

  constructor(config: SessionConfig) {
    this.config = config;
    this.storagePath = config.sessionStoragePath;

    if (config.persistSessions) {
      this.ensureStorageDirectory();
    }
  }

  /**
   * Periodically flush sessions/cookies to disk in addition to the shutdown save, so an
   * ungraceful exit (crash, OOM-kill) loses at most one interval's worth of session state
   * instead of everything since the last clean shutdown. No-ops when persistSessions is
   * off. Safe to call more than once — later calls replace the previous interval.
   */
  startAutosave(intervalMs: number = DEFAULT_AUTOSAVE_INTERVAL_MS): void {
    this.stopAutosave();

    if (!this.config.persistSessions) {
      return;
    }

    this.autosaveTimer = setInterval(() => {
      void this.saveToStorage().catch((error) => {
        getLogger().error('[SessionManager] Autosave failed', error as Error);
      });
    }, intervalMs);
    this.autosaveTimer.unref?.();
  }

  stopAutosave(): void {
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
    }
    this.autosaveTimer = null;
  }

  private ensureStorageDirectory(): void {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }

  /**
   * Generates the session key from the proxy URL.
   *
   * The URL is used verbatim rather than hashed: a short hash could collide, making two
   * proxies silently share cookies and fingerprint, which this map exists to prevent.
   */
  private getSessionKey(proxyUrl: string | null): string {
    if (!this.config.isolatePerProxy || !proxyUrl) {
      return 'direct';
    }
    return `proxy_${proxyUrl}`;
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  createSession(proxyUrl: string | null, fingerprint: BrowserFingerprint): Session {
    const key = this.getSessionKey(proxyUrl);
    const session: Session = {
      id: this.generateSessionId(),
      proxyUrl,
      cookies: [],
      localStorage: {},
      createdAt: Date.now(),
      lastUsed: Date.now(),
      fingerprint,
      requestCount: 0,
    };

    this.sessions.set(key, session);
    return session;
  }

  getSession(proxyUrl: string | null): Session | null {
    const key = this.getSessionKey(proxyUrl);
    const session = this.sessions.get(key);

    if (!session) {
      return null;
    }

    // Expired session.
    if (Date.now() - session.createdAt > this.config.maxSessionAge) {
      this.sessions.delete(key);
      return null;
    }

    if (
      this.config.cookieRotationInterval > 0 &&
      Date.now() - session.lastUsed > this.config.cookieRotationInterval
    ) {
      session.cookies = [];
      session.lastUsed = Date.now();
    }

    return session;
  }

  getOrCreateSession(proxyUrl: string | null, fingerprint: BrowserFingerprint): Session {
    let session = this.getSession(proxyUrl);
    if (!session) {
      session = this.createSession(proxyUrl, fingerprint);
    }
    return session;
  }

  updateCookies(sessionId: string, cookies: Cookie[]): void {
    for (const [, session] of this.sessions) {
      if (session.id === sessionId) {
        for (const newCookie of cookies) {
          const existingIndex = session.cookies.findIndex(
            (c) => c.name === newCookie.name && c.domain === newCookie.domain,
          );
          if (existingIndex >= 0) {
            session.cookies[existingIndex] = newCookie;
          } else {
            session.cookies.push(newCookie);
          }
        }
        session.lastUsed = Date.now();
        session.requestCount++;
        break;
      }
    }
  }

  /**
   * Get cookies for a session, optionally scoped to the host they're about to be sent to.
   *
   * A session is keyed by proxy, not by site, and collapses to the shared 'direct' key
   * whenever no proxy is configured — so one session's cookie jar can hold cookies from
   * several unrelated sources at once. Callers that are about to attach these to a
   * request must pass `targetUrl` so a cookie set by one source can't be replayed against
   * another; omitting it returns the whole jar and is only safe for inspection/persistence.
   */
  getCookies(sessionId: string, targetUrl?: string): Cookie[] {
    for (const [, session] of this.sessions) {
      if (session.id === sessionId) {
        const now = Date.now();
        const unexpired = session.cookies.filter((c) => !c.expires || c.expires * 1000 > now);

        return targetUrl ? cookiesForUrl(unexpired, targetUrl) : unexpired;
      }
    }
    return [];
  }

  clearCookies(sessionId: string): void {
    for (const [, session] of this.sessions) {
      if (session.id === sessionId) {
        session.cookies = [];
        break;
      }
    }
  }

  rotateSession(proxyUrl: string | null): Session {
    const key = this.getSessionKey(proxyUrl);
    const oldSession = this.sessions.get(key);

    // Keep the old fingerprint when rotating, if there is one.
    const fingerprint = oldSession?.fingerprint || {
      userAgent: 'Mozilla/5.0',
      platform: 'Win32',
      viewport: { width: 1920, height: 1080 },
      deviceMemory: 8,
      hardwareConcurrency: 8,
      maxTouchPoints: 0,
      timezone: 'America/New_York',
      language: 'en-US',
      languages: ['en-US', 'en'],
      colorDepth: 24,
      pixelRatio: 1,
      webglVendor: 'Google Inc.',
      webglRenderer: 'ANGLE',
    };

    return this.createSession(proxyUrl, fingerprint);
  }

  async saveToStorage(): Promise<void> {
    if (!this.config.persistSessions) {
      return;
    }

    this.ensureStorageDirectory();

    const sessionsArray = Array.from(this.sessions.entries()).map(([key, session]) => ({
      key,
      session,
    }));

    const filePath = path.join(this.storagePath, 'sessions.json');
    await fs.promises.writeFile(filePath, JSON.stringify(sessionsArray, null, 2));
  }

  async loadFromStorage(): Promise<void> {
    if (!this.config.persistSessions || this.loaded) {
      return;
    }

    const filePath = path.join(this.storagePath, 'sessions.json');

    if (!fs.existsSync(filePath)) {
      this.loaded = true;
      return;
    }

    try {
      const data = await fs.promises.readFile(filePath, 'utf-8');
      const sessionsArray = JSON.parse(data) as Array<{
        key: string;
        session: Session;
      }>;

      this.sessions.clear();
      for (const { key, session } of sessionsArray) {
        if (Date.now() - session.createdAt <= this.config.maxSessionAge) {
          this.sessions.set(key, session);
        }
      }

      this.loaded = true;
    } catch (error) {
      getLogger().error('[SessionManager] Failed to load sessions', error as Error);
      this.loaded = true;
    }
  }

  pruneExpiredSessions(): number {
    let pruned = 0;
    const now = Date.now();

    for (const [key, session] of this.sessions) {
      if (now - session.createdAt > this.config.maxSessionAge) {
        this.sessions.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

  async applyToPuppeteer(
    browser: { setCookie: (...cookies: Cookie[]) => Promise<void> },
    session: Session,
  ): Promise<void> {
    if (session.cookies.length > 0) {
      await browser.setCookie(...session.cookies);
    }
  }

  async applyToPlaywright(
    context: { addCookies: (cookies: Cookie[]) => Promise<void> },
    session: Session,
  ): Promise<void> {
    if (session.cookies.length > 0) {
      const playwrightCookies = session.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));
      await context.addCookies(playwrightCookies);
    }
  }

  getSessionById(sessionId: string): Session | null {
    for (const [, session] of this.sessions) {
      if (session.id === sessionId) {
        return session;
      }
    }
    return null;
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  deleteSession(sessionId: string): boolean {
    for (const [key, session] of this.sessions) {
      if (session.id === sessionId) {
        this.sessions.delete(key);
        return true;
      }
    }
    return false;
  }

  clearAllSessions(): void {
    this.sessions.clear();
  }

  updateConfig(config: Partial<SessionConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    if (config.sessionStoragePath) {
      this.storagePath = config.sessionStoragePath;
      this.ensureStorageDirectory();
    }
  }
}

let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(config?: SessionConfig): SessionManager {
  if (!sessionManagerInstance && config) {
    sessionManagerInstance = new SessionManager(config);
  }
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: false,
      sessionStoragePath: './data/sessions',
    });
  }
  return sessionManagerInstance;
}

export function resetSessionManager(): void {
  sessionManagerInstance?.stopAutosave();
  sessionManagerInstance = null;
}
