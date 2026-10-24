import { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { AnyNode } from 'domhandler';

import { TTLCache } from './cache.js';
import { getLogger } from '../features/DetectionLogger.js';

export interface JsonHtmlBrowseResponse {
  results_html: string;
  pagination_html?: string;
  total_results?: number;
  page: number;
  num_pages: number;
}

interface JsonHtmlPageResult<T> {
  items: T[];
  page: number;
  numPages: number;
}

interface FetchJsonHtmlPageConfig<T> {
  sourceId: string;
  cacheKeyPrefix: string;
  api: AxiosInstance;
  endpoint: string;
  itemSelector: string;
  buildParams: (page: number) => Record<string, string | number | boolean>;
  mapItem: (node: cheerio.Cheerio<AnyNode>, $: cheerio.CheerioAPI) => T | null;
  cacheTtlMs: number;
}

export interface FetchJsonHtmlBrowseConfig<T> {
  sourceId: string;
  cacheKeyPrefix: string;
  api: AxiosInstance;
  endpoint: string;
  itemSelector: string;
  sitePageSize: number;
  buildParams: (page: number) => Record<string, string | number | boolean>;
  mapItem: (node: cheerio.Cheerio<AnyNode>, $: cheerio.CheerioAPI) => T | null;
  cacheTtlMs?: number;
  maxPrefetchPages?: number;
}

export interface FetchJsonHtmlBrowseOptions {
  limit: number;
  offset: number;
}

const browseCache = new TTLCache<string, JsonHtmlBrowseResponse>(2 * 60 * 1000, 300, {
  autoPruneIntervalMs: 60 * 1000,
});

function buildCacheKey(
  cacheKeyPrefix: string,
  endpoint: string,
  params: Record<string, string | number | boolean>,
): string {
  const normalized = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');

  return `${cacheKeyPrefix}:${endpoint}?${normalized}`;
}

async function fetchJsonHtmlPage<T>(
  page: number,
  config: FetchJsonHtmlPageConfig<T>,
): Promise<JsonHtmlPageResult<T>> {
  const params = config.buildParams(page);
  const cacheKey = buildCacheKey(config.cacheKeyPrefix, config.endpoint, params);

  const payload = await browseCache.getOrSet(
    cacheKey,
    async () => {
      const { data } = await config.api.get<JsonHtmlBrowseResponse>(config.endpoint, { params });
      return data;
    },
    config.cacheTtlMs,
  );

  const $ = cheerio.load(payload.results_html || '');
  const items: T[] = [];

  $(config.itemSelector).each((_, el) => {
    const item = config.mapItem($(el), $);
    if (item) {
      items.push(item);
    }
  });

  if ((payload.results_html || '').trim().length > 0 && items.length === 0) {
    getLogger().warn(
      `[${config.sourceId}] Parsed 0 items for page=${page} at ${config.endpoint}. Check selectors.`,
    );
  }

  const numPages =
    Number.isFinite(payload.num_pages) && payload.num_pages > 0 ? payload.num_pages : page;

  return {
    items,
    page,
    numPages,
  };
}

/**
 * Fetches a slice of items from a source whose "browse" API returns JSON with an HTML
 * fragment inside (`results_html`) rather than structured data — `config.mapItem` does the
 * actual per-item parsing via `itemSelector`.
 *
 * Each page fetched through here is cached (`browseCache`, keyed by `cacheKeyPrefix` +
 * endpoint + params) for `cacheTtlMs`. Pages are requested starting from the one containing
 * `options.offset`, then fetched in batches of up to `maxPrefetchPages` at a time in
 * parallel until `options.limit` items are collected or the source reports no more pages —
 * the result is trimmed to exactly `[offset, offset + limit)` regardless of the source's own
 * page size.
 */
export async function fetchJsonHtmlBrowse<T>(
  config: FetchJsonHtmlBrowseConfig<T>,
  options: FetchJsonHtmlBrowseOptions,
): Promise<T[]> {
  const limit = Math.max(0, options.limit);
  const offset = Math.max(0, options.offset);

  if (limit === 0) {
    return [];
  }

  const sitePageSize = Math.max(1, config.sitePageSize);
  const maxPrefetchPages = Math.max(1, config.maxPrefetchPages ?? 2);
  const cacheTtlMs = config.cacheTtlMs ?? 2 * 60 * 1000;

  const startPage = Math.floor(offset / sitePageSize) + 1;
  let skipInPage = offset % sitePageSize;

  const pageConfig: FetchJsonHtmlPageConfig<T> = {
    sourceId: config.sourceId,
    cacheKeyPrefix: config.cacheKeyPrefix,
    api: config.api,
    endpoint: config.endpoint,
    itemSelector: config.itemSelector,
    buildParams: config.buildParams,
    mapItem: config.mapItem,
    cacheTtlMs,
  };

  const collected: T[] = [];

  const firstPage = await fetchJsonHtmlPage(startPage, pageConfig);
  const firstChunk = firstPage.items.slice(skipInPage, skipInPage + limit);
  collected.push(...firstChunk);

  let nextPage = startPage + 1;
  let maxPages = firstPage.numPages;
  skipInPage = 0;

  while (collected.length < limit && nextPage <= maxPages) {
    const remaining = limit - collected.length;
    const pagesNeeded = Math.ceil(remaining / sitePageSize);
    const batchSize = Math.min(maxPrefetchPages, pagesNeeded, maxPages - nextPage + 1);

    const pageNumbers = Array.from({ length: batchSize }, (_, i) => nextPage + i);
    const pageResults = await Promise.all(
      pageNumbers.map((pageNum) => fetchJsonHtmlPage(pageNum, pageConfig)),
    );

    for (const pageResult of pageResults) {
      maxPages = Math.max(maxPages, pageResult.numPages);

      const stillNeeded = limit - collected.length;
      if (stillNeeded <= 0) {
        break;
      }

      const chunk = pageResult.items.slice(0, stillNeeded);
      collected.push(...chunk);

      if (pageResult.items.length === 0) {
        return collected;
      }
    }

    nextPage += batchSize;
  }

  return collected;
}
