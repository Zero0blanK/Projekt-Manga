// Playwright-based HTML fetcher used as a browser fallback, with proxy, fingerprint and
// session support.

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { ProxyConfig, BrowserFingerprint } from './anon.config.js';
import { Session, cookiesForUrl } from '../features/SessionManager.js';
import { getLogger } from '../features/DetectionLogger.js';
import {
  getCloudflareCookiesForBrowser,
  updateCloudflareClearanceFromBrowserCookies,
} from '../features/CloudflareClearance.js';
import { CLOUDFLARE_PATTERNS, matchesAny } from '../utils/detectionPatterns.js';
import { buildFingerprintInjectionScript } from '../features/FingerprintManager.js';

// Pooled by proxy identity ('direct' for no proxy). Chromium only honors a proxy set at
// browser launch (a per-context override is silently ignored), so each proxy needs its
// own Browser. Everything else (userAgent/viewport/locale/timezoneId) is per-context, so
// a cheap BrowserContext is created per request and fingerprint rotation takes effect.
const MAX_POOLED_BROWSERS = 4;
const browserPool = new Map<string, Browser>();
// Dedupes concurrent launches for the same new proxy key; otherwise the second launch
// would overwrite and orphan the first in browserPool.
const launchesInFlight = new Map<string, Promise<Browser>>();

export interface PlaywrightFetchOptions {
  waitSelector?: string;
  timeout?: number;
  timeoutMs?: number;
  proxy?: ProxyConfig | null;
  fingerprint?: BrowserFingerprint | null;
  session?: Session | null;
  headless?: boolean;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Evicts the least-recently-used pooled browser(s) once over capacity. getBrowserForProxy()
 *  re-inserts on every reuse, so the first Map key is always the LRU entry. */
async function evictExcessBrowsers(): Promise<void> {
  while (browserPool.size > MAX_POOLED_BROWSERS) {
    const oldestKey = browserPool.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const evicted = browserPool.get(oldestKey);
    browserPool.delete(oldestKey);
    if (evicted) {
      try {
        await evicted.close();
      } catch {
        // Already closed or crashed; nothing left to close.
      }
    }
  }
}

/** Gets or launches the pooled browser process for this proxy identity. */
async function getBrowserForProxy(
  proxy?: ProxyConfig | null,
  headless: boolean = true,
): Promise<Browser> {
  const key = proxy?.url || 'direct';

  const pooled = browserPool.get(key);
  if (pooled) {
    if (pooled.isConnected()) {
      // Touch: re-insert to move this key to the most-recently-used position.
      browserPool.delete(key);
      browserPool.set(key, pooled);
      return pooled;
    }
    browserPool.delete(key);
  }

  const inFlight = launchesInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const launchPromise = (async () => {
    const launchOptions: Record<string, unknown> = { headless };

    if (proxy) {
      try {
        const proxyUrl = new URL(proxy.url);
        launchOptions.proxy = {
          server: `${proxyUrl.protocol}//${proxyUrl.host}`,
          username: proxyUrl.username || undefined,
          password: proxyUrl.password || undefined,
        };
      } catch {
        getLogger().warn('[Playwright] Invalid proxy URL', { url: proxy.url });
      }
    }

    const newBrowser = await chromium.launch(launchOptions);
    browserPool.set(key, newBrowser);
    await evictExcessBrowsers();
    return newBrowser;
  })();

  launchesInFlight.set(key, launchPromise);
  try {
    return await launchPromise;
  } finally {
    launchesInFlight.delete(key);
  }
}

/** Creates a fresh per-request context carrying the current fingerprint. */
async function createContext(
  browserInstance: Browser,
  fingerprint?: BrowserFingerprint | null,
): Promise<BrowserContext> {
  return browserInstance.newContext({
    userAgent: fingerprint?.userAgent || DEFAULT_UA,
    viewport: fingerprint?.viewport || { width: 1920, height: 1080 },
    locale: fingerprint?.language || 'en-US',
    timezoneId: fingerprint?.timezone || 'America/New_York',
  });
}

async function applyFingerprintScripts(page: Page, fingerprint: BrowserFingerprint): Promise<void> {
  await page.addInitScript(buildFingerprintInjectionScript(fingerprint));
}

async function applyDefaultStealth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Runs in the page, not in Node.
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  });
}

async function applySession(
  context: BrowserContext,
  session: Session,
  targetUrl: string,
): Promise<void> {
  // Scoped to the visited host: sessions are keyed by proxy and shared across sources, so
  // an unfiltered jar would leak another source's cookies.
  const scoped = session.cookies?.length ? cookiesForUrl(session.cookies, targetUrl) : [];
  if (scoped.length) {
    const playwrightCookies = scoped.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
    }));
    await context.addCookies(playwrightCookies);
  }
}

/**
 * Detects challenge pages. A plain "Access Denied" page is also waited out, but that phrase
 * is not a Cloudflare signature, so it stays out of CLOUDFLARE_PATTERNS (shared with sourceError.ts).
 */
function isChallengePage(html: string): boolean {
  return matchesAny(CLOUDFLARE_PATTERNS, html) || /access\s*denied/i.test(html);
}

export async function fetchHtmlWithPlaywright(
  url: string,
  options: PlaywrightFetchOptions = {},
): Promise<{ html: string; cookies: string[]; solved: boolean }> {
  const {
    waitSelector,
    timeout = 30000,
    timeoutMs,
    proxy,
    fingerprint,
    session,
    headless = true,
  } = options;

  const effectiveTimeout = timeoutMs || timeout;
  const logger = getLogger();
  const startTime = Date.now();
  const proxyUrl = proxy?.url || null;

  const browserInstance = await getBrowserForProxy(proxy, headless);
  const ctx = await createContext(browserInstance, fingerprint);

  if (session) {
    await applySession(ctx, session, url);
  }

  const page = await ctx.newPage();

  try {
    const clearanceCookies = getCloudflareCookiesForBrowser(url, proxyUrl).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
    }));

    if (clearanceCookies.length > 0) {
      await page.context().addCookies(clearanceCookies);
    }

    // Apply fingerprint or default stealth for this page only.
    if (fingerprint) {
      await applyFingerprintScripts(page, fingerprint);
    } else {
      await applyDefaultStealth(page);
    }

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: effectiveTimeout,
    });

    let html = await page.content();
    let solved = !isChallengePage(html);

    if (!solved) {
      logger.debug('Challenge detected, waiting...');
      await page.waitForTimeout(5000);
      html = await page.content();
      solved = !isChallengePage(html);
    }

    if (waitSelector && solved) {
      try {
        await page.waitForSelector(waitSelector, { timeout: 15000 });
      } catch {
        logger.debug('Wait selector timeout', { waitSelector });
      }
    }

    // Short settle delay for dynamic content.
    await page.waitForTimeout(1000);

    html = await page.content();

    const contextCookies = await ctx.cookies();
    updateCloudflareClearanceFromBrowserCookies(
      url,
      contextCookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
      })),
      proxyUrl,
    );

    const cookies = contextCookies.map(
      (c) => `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}`,
    );

    const responseTime = Date.now() - startTime;
    logger.debug('Playwright fetch completed', {
      url,
      solved,
      responseTime,
      proxy: proxy?.url,
    });

    return { html, cookies, solved };
  } finally {
    // Closing the context also closes its pages; the pooled browser stays open for reuse.
    try {
      await ctx.close();
    } catch {
      // Already closed or crashed; nothing left to close.
    }
  }
}

export async function shutdownPlaywright(): Promise<void> {
  const browsers = Array.from(browserPool.values());
  browserPool.clear();

  await Promise.all(
    browsers.map(async (b) => {
      try {
        await b.close();
      } catch {
        // Already closed or crashed; nothing left to close.
      }
    }),
  );
}
