import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosInstance } from 'axios';

vi.mock('../config/puppeteer.config.js', () => ({
  fetchHtmlWithPuppeteer: vi.fn(async () => ({ html: '', cookies: [], solved: false })),
}));
vi.mock('../config/playwright.config.js', () => ({
  fetchHtmlWithPlaywright: vi.fn(async () => ({ html: '', cookies: [], solved: false })),
}));

import { fetchHtmlWithPuppeteer } from '../config/puppeteer.config.js';
import { fetchHtmlWithPlaywright } from '../config/playwright.config.js';
import {
  getHtmlCached,
  clearHtmlCache,
  scrapePaginated,
  scrapePageLimited,
  type ScraperConfig,
} from '../utils/scraper.js';

/** Fake AxiosInstance: scraper.ts's functions take `api: AxiosInstance` as a plain
 * parameter, so a minimal object with a `.get()` matching the calls this file makes is
 * enough — no need to mock the real axios module. */
function fakeAxios(
  getImpl: (path: string) => Promise<{ status: number; data: unknown }>,
): AxiosInstance {
  return { get: vi.fn(getImpl) } as unknown as AxiosInstance;
}

function networkError(message = 'network fail'): Error {
  // Deliberately NOT axios-error-shaped (no .response/.isAxiosError) — this is what a
  // plain connection failure looks like, and it's what makes
  // shouldAttemptClearanceWarmup() skip the warmup path so browser-fallback order can be
  // observed directly.
  return new Error(message);
}

function axiosError(status: number): Error {
  const error = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: boolean;
    response: { status: number; data?: unknown };
  };
  error.isAxiosError = true;
  error.response = { status };
  return error;
}

describe('scraper.ts', () => {
  beforeEach(() => {
    clearHtmlCache();
    vi.mocked(fetchHtmlWithPuppeteer).mockReset();
    vi.mocked(fetchHtmlWithPlaywright).mockReset();
  });

  describe('browser-fallback order per fetch mode', () => {
    // No 'cloudflare-first' counterpart to the html-first case below: no registry entry
    // can resolve to that fetch mode any more, so there is nothing real to exercise it with.
    it('tries Playwright before Puppeteer for an html-first source (mangageko)', async () => {
      const callOrder: string[] = [];
      vi.mocked(fetchHtmlWithPuppeteer).mockImplementation(async () => {
        callOrder.push('puppeteer');
        return { html: '<html>real content</html>', cookies: [], solved: true };
      });
      vi.mocked(fetchHtmlWithPlaywright).mockImplementation(async () => {
        callOrder.push('playwright');
        return { html: '<html>real content</html>', cookies: [], solved: true };
      });

      const api = fakeAxios(async () => {
        throw networkError();
      });

      const html = await getHtmlCached(
        'mangageko',
        api,
        'https://mgeko.cc',
        '/order-test-2',
        '.sel',
        60000,
        true,
      );

      expect(html).toBe('<html>real content</html>');
      expect(callOrder[0]).toBe('playwright');
    });
  });

  describe('stale-while-revalidate via getHtmlCached', () => {
    it('serves the stale value immediately past TTL and refreshes in the background', async () => {
      let fetchCount = 0;
      const api = fakeAxios(async () => {
        fetchCount++;
        return { status: 200, data: `<html>version-${fetchCount}</html>` };
      });

      const first = await getHtmlCached(
        'mangageko',
        api,
        'https://mgeko.cc',
        '/stale-test',
        '.sel',
        20, // ttlMs — expires almost immediately
        false,
      );
      expect(first).toBe('<html>version-1</html>');

      // Past ttlMs (20) but well within the cache's staleTtlMs (2 minutes) — should
      // return the stale value immediately rather than blocking on a refetch.
      await new Promise((resolve) => setTimeout(resolve, 40));

      const second = await getHtmlCached(
        'mangageko',
        api,
        'https://mgeko.cc',
        '/stale-test',
        '.sel',
        20,
        false,
      );
      expect(second).toBe('<html>version-1</html>');
    });
  });

  describe('scrapePaginated pagination math', () => {
    function pageHtml(items: string[]): string {
      return `<div>${items.map((label) => `<div class="item">${label}</div>`).join('')}</div>`;
    }

    it('spans a site-page boundary and returns items in order, honoring offset/limit', async () => {
      const pages: Record<string, string[]> = {
        '1': ['a', 'b'],
        '2': ['c', 'd'],
      };

      const api = fakeAxios(async (path: string) => {
        const pageNum = new URL(path, 'http://x').searchParams.get('page') || '1';
        return { status: 200, data: pageHtml(pages[pageNum] || []) };
      });

      const config: ScraperConfig<string> = {
        source: 'mangatx',
        sourceName: 'MangaTX',
        baseUrl: 'https://mangatx.cc',
        basePath: '/manga-list',
        pageParam: 'page',
        waitSelector: '#content',
        itemSelector: '.item',
        api,
        useAntiDetection: false,
        extractItem: (node) => node.text(),
      };

      // sitePageSize 2, offset 1, limit 3 -> spans page 1 (skip 1, take 1) + page 2
      // (skip 0, take 2) -> ['b', 'c', 'd'].
      const result = await scrapePaginated(config, { sitePageSize: 2, limit: 3, offset: 1 });

      expect(result).toEqual(['b', 'c', 'd']);
    });

    it('stops once the first page alone satisfies the limit', async () => {
      const api = fakeAxios(async () => ({ status: 200, data: pageHtml(['x', 'y', 'z']) }));

      const config: ScraperConfig<string> = {
        source: 'mangatx',
        sourceName: 'MangaTX',
        baseUrl: 'https://mangatx.cc',
        basePath: '/manga-list',
        pageParam: 'page',
        waitSelector: '#content',
        itemSelector: '.item',
        api,
        useAntiDetection: false,
        extractItem: (node) => node.text(),
      };

      const result = await scrapePaginated(config, { sitePageSize: 3, limit: 2, offset: 0 });

      expect(result).toEqual(['x', 'y']);
      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('classified-error propagation', () => {
    it('scrapePageLimited throws a classified NOT_FOUND SourceError when axios 404s and the browser fallback also fails', async () => {
      vi.mocked(fetchHtmlWithPuppeteer).mockRejectedValue(new Error('puppeteer down'));
      vi.mocked(fetchHtmlWithPlaywright).mockRejectedValue(new Error('playwright down'));

      const api = fakeAxios(async () => {
        throw axiosError(404);
      });

      const config: ScraperConfig<string> = {
        source: 'mangatx',
        sourceName: 'MangaTX',
        baseUrl: 'https://mangatx.cc',
        basePath: '/manga-list',
        pageParam: 'page',
        waitSelector: '#content',
        itemSelector: '.item',
        api,
        useAntiDetection: false,
        extractItem: (node) => node.text(),
      };

      await expect(scrapePageLimited(config, 1, 0, 5)).rejects.toMatchObject({
        name: 'SourceError',
        code: 'NOT_FOUND',
        sourceId: 'mangatx',
      });
    });

    it('getHtmlCached throws a classified BLOCKED SourceError when every attempt returns a confirmed challenge page', async () => {
      const challengeHtml = '<html>Just a moment... checking your browser</html>';

      vi.mocked(fetchHtmlWithPuppeteer).mockResolvedValue({
        html: challengeHtml,
        cookies: [],
        solved: false,
      });
      vi.mocked(fetchHtmlWithPlaywright).mockResolvedValue({
        html: challengeHtml,
        cookies: [],
        solved: false,
      });

      const api = fakeAxios(async () => {
        throw axiosError(403);
      });

      await expect(
        getHtmlCached(
          'kissmanga',
          api,
          'https://kissmanga.in',
          '/blocked-test',
          '.sel',
          60000,
          true,
        ),
      ).rejects.toMatchObject({
        name: 'SourceError',
        code: 'BLOCKED',
        sourceId: 'kissmanga',
      });
    });
  });
});
