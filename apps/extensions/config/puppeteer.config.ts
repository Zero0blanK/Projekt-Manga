// Puppeteer-based HTML fetcher used as a browser fallback, with proxy, fingerprint and
// session support.

// puppeteer-extra's default export doesn't resolve cleanly through Node16/ESM interop with
// this package's CJS build; addExtra() is the documented alternative.
import { addExtra, PuppeteerExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import vanillaPuppeteer from 'puppeteer';
import type { Browser, HTTPRequest, Page } from 'puppeteer';
import { ProxyConfig, BrowserFingerprint } from './anon.config.js';
import { Session, cookiesForUrl } from '../features/SessionManager.js';
import { getLogger } from '../features/DetectionLogger.js';
import {
  getCloudflareCookiesForBrowser,
  updateCloudflareClearanceFromBrowserCookies,
} from '../features/CloudflareClearance.js';
import { CLOUDFLARE_PATTERNS, matchesAny } from '../utils/detectionPatterns.js';
import { buildFingerprintInjectionScript } from '../features/FingerprintManager.js';

// puppeteer-extra's VanillaPuppeteer type still requires createBrowserFetcher, which
// puppeteer v22+ removed. It is never called here, so the cast is safe.
const puppeteer: PuppeteerExtra = addExtra(
  vanillaPuppeteer as unknown as Parameters<typeof addExtra>[0],
);

puppeteer.use(StealthPlugin());

// Pooled by proxy identity ('direct' for no proxy). UA/viewport/fingerprint are applied
// per page (see applyFingerprint()), so only the proxy, a launch-time-only Chromium flag,
// requires a separate browser.
const MAX_POOLED_BROWSERS = 4;
const browserPool = new Map<string, Browser>();
// Dedupes concurrent launches for the same new proxy key; otherwise the second launch
// would overwrite and orphan the first in browserPool.
const launchesInFlight = new Map<string, Promise<Browser>>();

function buildLaunchArgs(proxy?: ProxyConfig | null): string[] {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1920,1080',
  ];

  if (proxy) {
    try {
      const proxyUrl = new URL(proxy.url);
      args.push(`--proxy-server=${proxyUrl.protocol}//${proxyUrl.host}`);
    } catch (e) {
      getLogger().warn('[Puppeteer] Invalid proxy URL', { url: proxy.url });
    }
  }

  return args;
}

/** Evicts the least-recently-used pooled browser(s) once over capacity. ensureBrowser()
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

/** Gets or launches the pooled browser for this proxy identity. */
async function ensureBrowser(
  proxy?: ProxyConfig | null,
  viewport?: { width: number; height: number },
): Promise<Browser> {
  const key = proxy?.url || 'direct';

  const pooled = browserPool.get(key);
  if (pooled) {
    if (pooled.connected) {
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
    const newBrowser = await puppeteer.launch({
      headless: true,
      args: buildLaunchArgs(proxy),
      defaultViewport: viewport || { width: 1920, height: 1080 },
    });
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

export interface FetchPageOptions {
  waitSelector?: string;
  timeoutMs?: number;
  retries?: number;
  blockImages?: boolean;
  proxy?: ProxyConfig | null;
  fingerprint?: BrowserFingerprint | null;
  session?: Session | null;
}

async function applyFingerprint(page: Page, fingerprint: BrowserFingerprint): Promise<void> {
  await page.setUserAgent(fingerprint.userAgent);
  await page.setViewport({
    width: fingerprint.viewport.width,
    height: fingerprint.viewport.height,
    deviceScaleFactor: fingerprint.pixelRatio,
  });

  await page.evaluateOnNewDocument(buildFingerprintInjectionScript(fingerprint));
}

async function applyDefaultFingerprint(page: Page): Promise<void> {
  const defaultUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36`;
  await page.setUserAgent(defaultUA);

  await page.evaluateOnNewDocument(() => {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    Object.defineProperty(nav, 'platform', { get: () => 'Win32' });
    Object.defineProperty(nav, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(nav, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(nav, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(nav, 'webdriver', { get: () => false });
  });
}

/**
 * Detects Cloudflare or similar challenges. A plain "Access Denied" page is also waited
 * out, but that phrase is not a Cloudflare signature, so it stays out of
 * CLOUDFLARE_PATTERNS (shared with sourceError.ts).
 */
function isChallengePage(html: string): boolean {
  return matchesAny(CLOUDFLARE_PATTERNS, html) || /access\s*denied/i.test(html);
}

async function waitForCloudflareClearance(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cookies = await page.cookies();
    if (cookies.some((cookie) => cookie.name.toLowerCase() === 'cf_clearance')) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function fetchHtmlWithPuppeteer(
  url: string,
  {
    waitSelector = '',
    timeoutMs = 20000,
    retries = 3,
    blockImages = false,
    proxy,
    fingerprint,
    session,
  }: FetchPageOptions = {},
): Promise<{ html: string; cookies: string[]; solved: boolean }> {
  const logger = getLogger();
  const startTime = Date.now();
  const proxyUrl = proxy?.url || null;

  const br = await ensureBrowser(proxy, fingerprint?.viewport);
  const page = await br.newPage();

  try {
    const clearanceCookies = getCloudflareCookiesForBrowser(url, proxyUrl).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    }));

    if (clearanceCookies.length > 0) {
      await page.setCookie(...clearanceCookies);
    }

    if (fingerprint) {
      await applyFingerprint(page, fingerprint);
    } else {
      await applyDefaultFingerprint(page);
    }

    // Session cookies are scoped to the visited host: sessions are keyed by proxy and
    // shared across sources, so an unfiltered jar would leak another source's cookies.
    const scopedCookies = session?.cookies?.length ? cookiesForUrl(session.cookies, url) : [];
    if (scopedCookies.length) {
      const puppeteerCookies = scopedCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
      }));
      await br.setCookie(...puppeteerCookies);
    }

    // Optionally block heavy resources.
    if (blockImages) {
      await page.setRequestInterception(true);
      page.on('request', (req: HTTPRequest) => {
        const type = req.resourceType();
        if (['image', 'media', 'font'].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });
    }

    let solved = false;
    // Set once a managed challenge goes unclearable (full wait, no clearance cookie). A
    // same-fingerprint retry almost never clears it, so only one more attempt is made
    // instead of paying the ~12s wait for the whole `retries` budget.
    let sawUnclearedChallenge = false;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: timeoutMs,
        });

        if (!res || res.status() >= 400) {
          logger.warn(`Request failed with status: ${res?.status()}`, { url });
        }

        const content = await page.content();

        if (isChallengePage(content)) {
          logger.debug('Cloudflare challenge detected, waiting...');
          const clearanceSolved = await waitForCloudflareClearance(page, 12000);
          if (!clearanceSolved) {
            if (sawUnclearedChallenge) break;
            sawUnclearedChallenge = true;
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
          }
          const postChallengeContent = await page.content();
          if (isChallengePage(postChallengeContent)) {
            continue;
          }
        }

        if (waitSelector) {
          await page.waitForSelector(waitSelector, { timeout: 15000 });
        }

        solved = true;
        break;
      } catch (err) {
        logger.warn(`Attempt ${attempt + 1}/${retries} failed`, {
          url,
          error: (err as Error).message,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    const html = await page.content();
    const browserCookies = await page.cookies();
    updateCloudflareClearanceFromBrowserCookies(
      url,
      browserCookies.map((cookie) => ({
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

    const cookies = browserCookies.map(
      (cookie) => `${cookie.name}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}`,
    );

    const responseTime = Date.now() - startTime;
    logger.debug('Puppeteer fetch completed', {
      url,
      solved,
      responseTime,
      proxy: proxy?.url,
    });

    return { html, cookies, solved };
  } finally {
    await page.close();
  }
}

export async function shutdownPuppeteer(): Promise<void> {
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
