// Cached HTML fetching (axios first, then Playwright/Puppeteer fallback) and the
// paginated list/chapter scraping helpers built on it.

import * as cheerio from 'cheerio';
import { fetchHtmlWithPuppeteer } from '../config/puppeteer.config.js';
import { fetchHtmlWithPlaywright } from '../config/playwright.config.js';
import { getSourceFetchMode, getBrowserFallbackTimeoutMs } from '../config/source.config.js';
import { AxiosInstance } from 'axios';
import { AnyNode } from 'domhandler';

import { TTLCache } from './cache.js';
import { getOrchestrator } from '../features/Orchestrator.js';
import type { AntiDetectionContext } from '../features/Orchestrator.js';
import { getLogger } from '../features/DetectionLogger.js';
import { getSourceCircuitBreaker } from '../features/SourceCircuitBreaker.js';
import { classifyRequestError, SourceError } from '../sourceError.js';

const htmlCache = new TTLCache<string, string>(5 * 60 * 1000, 300, {
  autoPruneIntervalMs: 60 * 1000,
  // Serve stale HTML for up to 2 minutes past TTL while refreshing in the background, so
  // callers after expiry don't block on a full scrape.
  staleTtlMs: 2 * 60 * 1000,
});
const clearanceWarmupCooldown = new Map<string, number>();
const inFlightClearanceWarmups = new Map<string, Promise<WarmupResult>>();
const CLEARANCE_WARMUP_COOLDOWN_MS = 8 * 60 * 1000;

function isBlockedHtml(
  orchestrator: ReturnType<typeof getOrchestrator>,
  html: string,
  statusCode: number = 200,
): boolean {
  if (!html || html.trim().length === 0) {
    return true;
  }

  if (orchestrator.isCloudflareChallenge(html) || orchestrator.isCaptchaPage(html)) {
    return true;
  }

  if (orchestrator.isBanResponse(html, statusCode)) {
    return true;
  }

  return /attention required|access denied|request blocked/i.test(html);
}

function extractHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const maybeResponse = (error as { response?: { status?: number } }).response;
  if (maybeResponse && typeof maybeResponse.status === 'number') {
    return maybeResponse.status;
  }

  return null;
}

function shouldAttemptClearanceWarmup(
  error: unknown,
  orchestrator: ReturnType<typeof getOrchestrator>,
): boolean {
  const status = extractHttpStatus(error);
  if (status === 403 || status === 429 || status === 503) {
    return true;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const responseData = (error as { response?: { data?: unknown } }).response?.data;
  return (
    typeof responseData === 'string' && isBlockedHtml(orchestrator, responseData, status || 200)
  );
}

function buildWarmupKey(source: string, url: string, context: AntiDetectionContext | null): string {
  let hostname = 'unknown';
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Keep fallback hostname for malformed URLs.
  }

  return `${source}:${hostname}:${context?.proxy?.url || 'direct'}`;
}

interface WarmupResult {
  /** True if the axios cookie jar is now worth a retry — a cheap axios re-fetch can
   * succeed even when `result` itself doesn't have usable HTML (e.g. it belongs to a
   * different concurrent request; see `forUrl`). */
  warmed: boolean;
  /** The browser-fallback outcome for `forUrl`. */
  result: BrowserFallbackResult;
  /** The URL this warmup actually fetched. `buildWarmupKey` dedupes by source+host, not
   * by path, so a request for a *different* path on the same host can piggyback on an
   * in-flight warmup that was really fetching someone else's URL — a caller must check
   * this equals its own `url` before treating `result` as the answer to its own request. */
  forUrl: string;
}

async function warmupCloudflareClearance(
  source: string,
  url: string,
  waitSelector: string,
  context: AntiDetectionContext | null,
  orchestrator: ReturnType<typeof getOrchestrator>,
  logger: ReturnType<typeof getLogger>,
): Promise<WarmupResult> {
  const key = buildWarmupKey(source, url, context);
  const now = Date.now();
  const cooldownUntil = clearanceWarmupCooldown.get(key) || 0;

  if (cooldownUntil > now) {
    // Warmed recently for this host — nothing was fetched just now, so there's no HTML
    // to hand back, only the signal that an axios retry is worth trying.
    return { warmed: true, result: { html: null, blocked: false }, forUrl: url };
  }

  const inFlight = inFlightClearanceWarmups.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<WarmupResult> => {
    logger.debug('[scraper] Starting Cloudflare clearance warmup', { source, url });

    const result = await fetchWithBrowserFallback(
      source,
      url,
      waitSelector,
      getBrowserFallbackTimeoutMs(),
      context,
      orchestrator,
      logger,
    );

    const succeeded = Boolean(result.html && !isBlockedHtml(orchestrator, result.html));
    if (succeeded) {
      clearanceWarmupCooldown.set(key, Date.now() + CLEARANCE_WARMUP_COOLDOWN_MS);
    }

    return { warmed: succeeded, result, forUrl: url };
  })().finally(() => {
    inFlightClearanceWarmups.delete(key);
  });

  inFlightClearanceWarmups.set(key, task);
  return task;
}

interface BrowserFallbackResult {
  html: string | null;
  /** True only when at least one attempt actually got HTML back and that HTML was
   * classified as a challenge/CAPTCHA/ban page — i.e. we know *why* it failed, not just
   * that it did. Kept separate from "no html at all" (timeout, crashed navigation, no
   * network) so a genuine block can be reported as one instead of a generic failure. */
  blocked: boolean;
}

async function fetchWithBrowserFallback(
  source: string,
  url: string,
  waitSelector: string,
  timeoutMs: number,
  context: AntiDetectionContext | null,
  orchestrator: ReturnType<typeof getOrchestrator>,
  logger: ReturnType<typeof getLogger>,
): Promise<BrowserFallbackResult> {
  const fetchMode = getSourceFetchMode(source);
  const browsers =
    fetchMode === 'cloudflare-first' ? ['puppeteer', 'playwright'] : ['playwright', 'puppeteer'];

  const contextsToTry: Array<AntiDetectionContext | null> = [context];
  let rotateAttempted = false;
  let sawBlockedHtml = false;

  for (let i = 0; i < contextsToTry.length; i++) {
    const activeContext = contextsToTry[i];
    let encounteredBlockedHtml = false;

    for (const browserType of browsers) {
      try {
        const result =
          browserType === 'puppeteer'
            ? await fetchHtmlWithPuppeteer(url, {
                waitSelector,
                timeoutMs,
                retries: 3,
                blockImages: false,
                ...(activeContext && {
                  proxy: activeContext.proxy,
                  fingerprint: activeContext.fingerprint,
                  session: activeContext.session,
                }),
              })
            : await fetchHtmlWithPlaywright(url, {
                waitSelector,
                timeoutMs,
                ...(activeContext && {
                  proxy: activeContext.proxy,
                  fingerprint: activeContext.fingerprint,
                  session: activeContext.session,
                }),
              });

        // Only html that actually came back *and* matched a challenge/ban pattern counts
        // as a confirmed block — html-less failures (timeout, crashed navigation) don't
        // tell us that, and treating them as "blocked" would misreport a different fault
        // as Cloudflare the next time this runs for any source, not just this one.
        if (result.html) {
          if (!isBlockedHtml(orchestrator, result.html)) {
            return { html: result.html, blocked: false };
          }
          encounteredBlockedHtml = true;
          sawBlockedHtml = true;
        }
      } catch (error) {
        logger.debug(`[scraper] ${browserType} fallback failed`, {
          url,
          error: (error as Error).message,
        });
      }
    }

    if (encounteredBlockedHtml && activeContext && !rotateAttempted && orchestrator.isEnabled()) {
      rotateAttempted = true;
      try {
        const rotated = await orchestrator.emergencyRotate(activeContext);
        contextsToTry.push(rotated);
      } catch (rotateError) {
        logger.debug('[scraper] Emergency rotate failed during browser fallback', {
          url,
          error: (rotateError as Error).message,
        });
      }
    }
  }

  return { html: null, blocked: sawBlockedHtml };
}

export async function getHtmlCached(
  source: string,
  api: AxiosInstance,
  baseUrl: string,
  path: string,
  waitSelector: string,
  ttlMs: number,
  useAntiDetection: boolean = true,
): Promise<string> {
  const url = `${baseUrl}${path}`;
  const key = `${source}:${url}`;
  const logger = getLogger();
  const orchestrator = getOrchestrator();
  const breaker = getSourceCircuitBreaker();

  async function fetchHtmlForCache(): Promise<string> {
    let context = null;
    if (useAntiDetection && orchestrator.isEnabled()) {
      await orchestrator.waitRandomDelay();
      context = await orchestrator.getContext();
    }

    let shouldWarmup = false;

    // 1) axios first; its instance already rate-limits.
    try {
      const axiosStart = Date.now();
      const res = await api.get(path);
      if (
        res.status === 200 &&
        typeof res.data === 'string' &&
        res.data.length > 0 &&
        !isBlockedHtml(orchestrator, res.data, res.status)
      ) {
        if (context) {
          orchestrator.reportSuccess(context, Date.now() - axiosStart);
        }
        return res.data;
      }

      shouldWarmup =
        typeof res.data === 'string' && isBlockedHtml(orchestrator, res.data, res.status);
    } catch (axiosError) {
      shouldWarmup = shouldAttemptClearanceWarmup(axiosError, orchestrator);
      logger.debug('Axios fetch failed, trying browser fallback', {
        url,
        error: (axiosError as Error).message,
      });
    }

    if (shouldWarmup) {
      const warmupStart = Date.now();
      const warmup = await warmupCloudflareClearance(
        source,
        url,
        waitSelector,
        context,
        orchestrator,
        logger,
      );

      // The warmup fetched exactly this URL, so its result is already the answer to step 2;
      // don't rerun the browser-fallback chain. `forUrl` won't match when a concurrent
      // request for another path on this host owns the in-flight warmup, in which case
      // this falls through and fetches its own URL.
      const gotOwnResult = warmup.forUrl === url;

      if (gotOwnResult && warmup.result.html && !isBlockedHtml(orchestrator, warmup.result.html)) {
        if (context) {
          orchestrator.reportSuccess(context, Date.now() - warmupStart);
        }
        return warmup.result.html;
      }

      if (warmup.warmed) {
        try {
          const retryStart = Date.now();
          const retry = await api.get(path);
          if (
            retry.status === 200 &&
            typeof retry.data === 'string' &&
            retry.data.length > 0 &&
            !isBlockedHtml(orchestrator, retry.data, retry.status)
          ) {
            if (context) {
              orchestrator.reportSuccess(context, Date.now() - retryStart);
            }
            return retry.data;
          }
        } catch (retryError) {
          logger.debug('Axios retry after clearance warmup failed', {
            url,
            error: (retryError as Error).message,
          });
        }
      }

      // Warmup already ran the full browser-fallback chain against exactly this URL and
      // every attempt came back a confirmed challenge/CAPTCHA page — running that chain
      // again immediately below would just reproduce the same result.
      if (gotOwnResult && warmup.result.blocked) {
        if (context) {
          orchestrator.reportFailure(context, new Error(`Browser fallback failed for ${url}`));
        }
        throw new SourceError(
          'BLOCKED',
          `${source} is blocking automated requests (Cloudflare). Try again later.`,
          source,
          {
            reason: 'Cloudflare managed challenge',
            detail: `Every fetch attempt for ${url} returned a challenge/CAPTCHA page instead of content.`,
            url,
          },
        );
      }
    }

    // 2) Browser fallback. Cloudflare-heavy sources prioritize Puppeteer first. Only
    // reached when warmup wasn't attempted, was for a different concurrent URL, or
    // failed without a confirmed cause (e.g. a plain network error) — a confirmed block
    // against this exact URL already returned/threw above.
    const browserFallbackStart = Date.now();
    const fallback = await fetchWithBrowserFallback(
      source,
      url,
      waitSelector,
      getBrowserFallbackTimeoutMs(),
      context,
      orchestrator,
      logger,
    );

    if (fallback.html) {
      if (context) {
        orchestrator.reportSuccess(context, Date.now() - browserFallbackStart);
      }
      return fallback.html;
    }

    if (context) {
      orchestrator.reportFailure(context, new Error(`Browser fallback failed for ${url}`));
    }

    // Every fallback attempt returned a challenge/CAPTCHA/ban page, so report it as a block
    // instead of classifyRequestError's generic "unexpected data" guess, which would
    // misreport a Cloudflare block as a layout change.
    if (fallback.blocked) {
      throw new SourceError(
        'BLOCKED',
        `${source} is blocking automated requests (Cloudflare). Try again later.`,
        source,
        {
          reason: 'Cloudflare managed challenge',
          detail: `Every fetch attempt for ${url} returned a challenge/CAPTCHA page instead of content.`,
          url,
        },
      );
    }

    // Throwing keeps failed results out of the cache.
    throw new Error(`Failed to fetch HTML for ${baseUrl}${path}`);
  }

  return htmlCache.getOrSet(
    key,
    async () => {
      const openRemainingMs = breaker.getOpenRemainingMs(source);
      if (openRemainingMs > 0) {
        throw new SourceError(
          'BLOCKED',
          `${source} has failed repeatedly and is temporarily paused — retrying in ${Math.ceil(openRemainingMs / 1000)}s.`,
          source,
        );
      }

      try {
        const html = await fetchHtmlForCache();
        breaker.recordSuccess(source);
        return html;
      } catch (error) {
        breaker.recordFailure(source);
        throw error;
      }
    },
    ttlMs,
  );
}

export interface ScraperConfig<T> {
  source?: string;
  sourceName?: string;
  baseUrl: string;
  basePath: string;
  pageParam: string;
  waitSelector: string;
  itemSelector: string;
  api: AxiosInstance;
  extractItem: (node: cheerio.Cheerio<AnyNode>) => T;
  useAntiDetection?: boolean;
}

export async function scrapePageLimited<T>(
  config: ScraperConfig<T>,
  pageNum: number,
  skip: number,
  take: number,
): Promise<T[]> {
  if (take <= 0) {
    return [];
  }

  const {
    baseUrl,
    basePath,
    pageParam,
    waitSelector,
    itemSelector,
    extractItem,
    api,
    useAntiDetection = true,
  } = config;

  const logger = getLogger();
  const orchestrator = getOrchestrator();
  const breaker = getSourceCircuitBreaker();
  const sourceKey = config.source || 'unknown';

  const openRemainingMs = breaker.getOpenRemainingMs(sourceKey);
  if (openRemainingMs > 0) {
    throw new SourceError(
      'BLOCKED',
      `${config.sourceName || sourceKey} has failed repeatedly and is temporarily paused — retrying in ${Math.ceil(openRemainingMs / 1000)}s.`,
      sourceKey,
    );
  }

  const urlPath = `${basePath}${basePath.includes('?') ? '&' : '?'}${pageParam}=${pageNum}`;
  let html: string | null = null;
  let lastError: unknown = null;

  let context = null;
  if (useAntiDetection && orchestrator.isEnabled()) {
    await orchestrator.waitRandomDelay();
    context = await orchestrator.getContext();
  }

  try {
    const res = await api.get(urlPath);
    if (typeof res.data === 'string' && !isBlockedHtml(orchestrator, res.data, res.status)) {
      html = res.data;
    }
  } catch (error) {
    lastError = error;
    logger.debug(`Axios fetch failed for page ${pageNum}`, {
      error: (error as Error).message,
    });
  }

  if (!html) {
    const pageFetchStart = Date.now();
    const pageUrl = `${baseUrl}${urlPath}`;
    try {
      const fallback = await fetchWithBrowserFallback(
        config.source || 'unknown',
        pageUrl,
        waitSelector,
        getBrowserFallbackTimeoutMs(),
        context,
        orchestrator,
        logger,
      );
      html = fallback.html;

      if (context && html) {
        orchestrator.reportSuccess(context, Date.now() - pageFetchStart);
      } else if (fallback.blocked) {
        // Every attempt returned a challenge/CAPTCHA page: report that instead of leaving
        // `lastError` as whatever axios saw, which would reach classifyRequestError's
        // generic "unexpected data" guess below.
        lastError = new SourceError(
          'BLOCKED',
          `${sourceKey} is blocking automated requests (Cloudflare). Try again later.`,
          sourceKey,
          {
            reason: 'Cloudflare managed challenge',
            detail: `Every fetch attempt for ${pageUrl} returned a challenge/CAPTCHA page instead of content.`,
            url: pageUrl,
          },
        );
      }
    } catch (error) {
      lastError = error;
      if (context) {
        orchestrator.reportFailure(context, error as Error);
      }
      logger.error(`Error fetching page ${pageNum} with Puppeteer`, error as Error);
    }
  }

  // A real fetch failure (both axios and the browser fallback couldn't get the page)
  // must be surfaced — it's not the same as a legitimately empty results page.
  if (!html) {
    breaker.recordFailure(sourceKey);
    throw classifyRequestError(
      lastError,
      sourceKey,
      config.sourceName || sourceKey || 'the source',
    );
  }

  breaker.recordSuccess(sourceKey);

  const $ = cheerio.load(html);
  const collected: T[] = [];

  let skipped = 0;
  let taken = 0;

  $(itemSelector).each((_, el) => {
    if (skipped < skip) {
      skipped++;
      return;
    }

    if (taken >= take) {
      return false; // Stop cheerio iteration
    }

    try {
      const item = extractItem($(el));
      if (item) {
        collected.push(item);
        taken++;
      }
    } catch (error) {
      logger.error('Error extracting item', error as Error);
    }
  });

  return collected;
}

export interface PaginatedScrapeOptions {
  sitePageSize: number;
  limit: number;
  offset: number;
}

export async function scrapePaginated<T>(
  config: ScraperConfig<T>,
  options: PaginatedScrapeOptions,
): Promise<T[]> {
  const { sitePageSize, limit, offset } = options;

  const startSitePage = Math.floor(offset / sitePageSize) + 1;
  const offsetInStartPage = offset % sitePageSize;

  const needNextPage = offsetInStartPage + limit > sitePageSize;

  if (needNextPage) {
    const takeFromFirstPage = Math.max(sitePageSize - offsetInStartPage, 0);
    const takeFromNextPage = Math.max(limit - takeFromFirstPage, 0);

    const [firstBatch, nextBatch] = await Promise.all([
      scrapePageLimited(config, startSitePage, offsetInStartPage, takeFromFirstPage),
      scrapePageLimited(config, startSitePage + 1, 0, takeFromNextPage),
    ]);

    return [...firstBatch, ...nextBatch].slice(0, limit);
  }

  const firstBatch = await scrapePageLimited(config, startSitePage, offsetInStartPage, limit);

  if (firstBatch.length >= limit) {
    return firstBatch;
  }

  const remain = limit - firstBatch.length;
  const nextBatch = await scrapePageLimited(config, startSitePage + 1, 0, remain);

  return [...firstBatch, ...nextBatch];
}

export interface ChapterPagesConfig<T> {
  source: string;
  sourceName?: string;
  baseUrl: string;
  chapterUrl: string;
  waitSelector: string;
  itemSelector: string;
  api: AxiosInstance;
  extractItem?: (node: cheerio.Cheerio<AnyNode>, index: number) => T;
  extractItemOnConfig?: (
    item: T,
    index: number,
  ) => Promise<T | null | undefined> | T | null | undefined;
  useAntiDetection?: boolean;
}

export interface ChapterPagesPaginationOptions {
  limit: number;
  offset: number;
}

export interface ChapterPagesResult<T> {
  items: T[];
  total: number;
}

export async function scrapeChapterPages<T>(
  config: ChapterPagesConfig<T>,
  options: ChapterPagesPaginationOptions,
): Promise<ChapterPagesResult<T>> {
  const {
    source,
    sourceName,
    baseUrl,
    chapterUrl,
    waitSelector,
    itemSelector,
    extractItem,
    extractItemOnConfig,
    api,
    useAntiDetection = true,
  } = config;
  const { limit, offset } = options;
  const logger = getLogger();

  const ttlMs = 5 * 60 * 1000; // 5 minutes

  let html: string;
  try {
    html = await getHtmlCached(
      source,
      api,
      baseUrl,
      chapterUrl,
      waitSelector,
      ttlMs,
      useAntiDetection,
    );
  } catch (error) {
    logger.error(`[scraper] getHtmlCached failed`, error as Error);
    throw classifyRequestError(error, source, sourceName || source);
  }

  const $ = cheerio.load(html);

  const element = $(itemSelector).toArray();
  const total = element.length;

  if (total === 0) {
    // The page loaded but no page images matched — almost certainly the site changed
    // its markup rather than a genuinely empty chapter.
    throw classifyRequestError(
      new Error('no matching page elements'),
      source,
      sourceName || source,
    );
  }

  const start = Math.min(offset, total);
  const end = Math.min(total, start + limit);

  const items: T[] = [];

  for (let i = start; i < end; i++) {
    const node = $(element[i]);
    try {
      const extracted = extractItem ? extractItem(node, i) : undefined;
      const item = extractItemOnConfig ? await extractItemOnConfig(extracted!, i) : extracted;

      if (item) {
        items.push(item);
      }
    } catch (error) {
      logger.error('Error extracting chapter page item', error as Error);
    }
  }

  return { items, total };
}

export async function baseUrlPageScraper<T>(
  source: string,
  api: AxiosInstance,
  baseUrl: string,
  options: {
    delayMs?: number;
    ttlMs?: number;
    buildPath: (item: T, index: number) => string;
    waitSelector: string;
    extractItem: (html: string, item: T, index: number) => T | null;
    useAntiDetection?: boolean;
  },
  item: T,
  index: number,
): Promise<T | null> {
  const {
    delayMs = 250,
    ttlMs = 5 * 60 * 1000,
    buildPath,
    waitSelector,
    extractItem,
    useAntiDetection = true,
  } = options;
  const logger = getLogger();
  const orchestrator = getOrchestrator();

  if (useAntiDetection && orchestrator.isEnabled()) {
    await orchestrator.waitRandomDelay();
  } else if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const path = buildPath(item, index);

  let html: string;

  try {
    html = await getHtmlCached(source, api, baseUrl, path, waitSelector, ttlMs, useAntiDetection);
  } catch (e) {
    logger.error(`[scraper] baseUrlPageScraper getHtmlCached failed`, e as Error);
    return null;
  }

  return extractItem(html, item, index);
}

export function parseHtml(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}

export function clearHtmlCache(): void {
  htmlCache.clear();
}

export function getCacheStats() {
  return htmlCache.getStats();
}
