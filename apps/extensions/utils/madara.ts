import * as cheerio from 'cheerio';
import { AxiosInstance } from 'axios';

import type {
  Source,
  Mangas,
  Chapters,
  MangaFilter,
  Page,
  MangaDetails,
  FilterValue,
  Pagination,
  ChapterPagesResult,
} from '@projekt-manga/types';
import { getHtmlCached } from './scraper.js';
import { toAbsoluteUrl } from './url.js';
import { mapMangaStatus, parseDateToIso } from './parse.js';
import { SourceError, classifyRequestError } from '../sourceError.js';

interface MadaraSelectors {
  browseCard: string;
  browseLink: string;
  browseTitle: string;
  browseImage: string;
  detailsTitle: string;
  detailsThumbnail: string;
  detailsAuthor: string;
  detailsGenres: string;
  detailsDescription: string;
  detailsStatus: string;
  chapterItem: string;
  chapterLink: string;
  chapterName: string;
  chapterDate: string;
  pageImage: string;
}

interface MadaraRuntimeConfig {
  waitSelector: string;
  sitePageSize: number;
  cacheTtlMs: number;
  useAntiDetection: boolean;
}

export interface MadaraSourceConfig {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  isNSFW: boolean;
  api: AxiosInstance;
  selectors?: Partial<MadaraSelectors>;
  runtime?: Partial<MadaraRuntimeConfig>;
  buildBrowsePath?: (
    category: string | undefined,
    page: number,
    filters: Record<string, FilterValue>,
  ) => string;
  buildSearchPath?: (
    query: string | undefined,
    page: number,
    filters: Record<string, FilterValue>,
  ) => string;
  buildMangaPath?: (mangaId: string) => string;
  buildChapterPath?: (chapterKey: string, mangaSlug?: string) => string;
  getFilters?: () => Promise<MangaFilter[]> | MangaFilter[];
  fetchMangaUpdates?: (mangaSlug: string) => Promise<Chapters[]>;
}

const DEFAULT_SELECTORS: MadaraSelectors = {
  browseCard: '.page-item-listing, .c-tabs-item__content, article.comic-card',
  browseLink: 'a',
  browseTitle: '.item-summary h3 a, .post-title h3 a, .post-title a, .comic-card__title a',
  browseImage: 'img',
  detailsTitle: 'h1.novel-title, .post-title h1, h1',
  detailsThumbnail:
    'header.novel-header .cover img, .summary_image img, .post-content_item .summary_image img',
  detailsAuthor:
    'span[itemprop="author"], .author-content a, .author-content, .post-content_item:contains("Author") .summary-content a',
  detailsGenres:
    '.categories li a, .genres-content a, .post-content_item:contains("Genre") .summary-content a',
  detailsDescription: 'p.description, .description-summary, .summary__content p, .summary__content',
  detailsStatus:
    '.post-status .summary-content, .post-content_item:contains("Status") .summary-content, small:contains("Status")',
  chapterItem:
    'li.chapter-list-item, ul.chapter-list li, li.wp-manga-chapter, .listing-chapters_wrap li',
  chapterLink: 'a',
  chapterName: '.chapter-number, .chapter-manhwa-title, a',
  chapterDate: 'time, .chapter-release-date, .chapter-stats, .chapter-update',
  pageImage: '.reading-content img, img[id^="image-"]',
};

const DEFAULT_RUNTIME: MadaraRuntimeConfig = {
  waitSelector: 'body',
  sitePageSize: 24,
  cacheTtlMs: 2 * 60 * 1000,
  useAntiDetection: true,
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractMangaSlug(url: string): string {
  const noQuery = url.split('?')[0];
  const match = noQuery.match(/\/manga\/([^/]+)\/?/) || noQuery.match(/\/kissmanga\/([^/]+)\/?/);
  return match?.[1] || '';
}

function extractChapterKey(url: string): string {
  const noQuery = url.split('?')[0].replace(/\/+$/, '');
  const readerMatch = noQuery.match(/\/reader\/[^/]+\/([^/]+)$/);
  if (readerMatch?.[1]) {
    return readerMatch[1];
  }

  const segments = noQuery.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

function parseChapterNumber(rawName: string, fallback: number): number {
  const parsed = Number.parseFloat(rawName.match(/[\d.]+/)?.[0] || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Throws a classified SourceError on any failure — callers should not treat a caught
 * error the same as a legitimately empty page. */
async function fetchSourceHtml(
  sourceId: string,
  sourceName: string,
  api: AxiosInstance,
  baseUrl: string,
  path: string,
  waitSelector: string,
  cacheTtlMs: number,
  useAntiDetection: boolean,
): Promise<string> {
  try {
    return await getHtmlCached(
      sourceId,
      api,
      baseUrl,
      path,
      waitSelector,
      cacheTtlMs,
      useAntiDetection,
    );
  } catch (error) {
    throw classifyRequestError(error, sourceId, sourceName);
  }
}

function defaultBrowsePath(category: string | undefined, page: number): string {
  const order = category === 'popular' ? 'popular' : 'latest';
  return `/manga/?m_orderby=${order}&page=${page}`;
}

function defaultSearchPath(query: string | undefined, page: number): string {
  return `/?s=${encodeURIComponent(query || '')}&post_type=wp-manga&page=${page}`;
}

function defaultMangaPath(mangaId: string): string {
  return `/manga/${mangaId}/`;
}

function defaultChapterPath(chapterKey: string, mangaSlug?: string): string {
  const safeChapterKey = chapterKey.replace(/^\/+|\/+$/g, '');
  if (mangaSlug) {
    return `/manga/${mangaSlug}/${safeChapterKey}/`;
  }

  return `/${safeChapterKey}/`;
}

function parseBrowseItems(
  $: cheerio.CheerioAPI,
  selectors: MadaraSelectors,
  sourceId: string,
  baseUrl: string,
): Mangas[] {
  return $(selectors.browseCard)
    .map((_, el) => {
      const node = $(el);
      const linkNode = node.find(selectors.browseLink).first();
      const titleNode = node.find(selectors.browseTitle).first();
      const imageNode = node.find(selectors.browseImage).first();

      const href = titleNode.attr('href') || linkNode.attr('href') || '';
      const id = extractMangaSlug(href);
      if (!id) {
        return null;
      }

      const imageSrc =
        imageNode.attr('data-src') ||
        imageNode.attr('data-lazy-src') ||
        imageNode.attr('src') ||
        '';

      return {
        source: sourceId,
        id,
        slug: id,
        title: normalizeText(titleNode.text()) || 'No Title',
        thumbnail_url: toAbsoluteUrl(imageSrc, baseUrl),
      } as Mangas;
    })
    .get()
    .filter((item): item is Mangas => item !== null);
}

async function fetchPagedManga(
  config: MadaraSourceConfig,
  selectors: MadaraSelectors,
  runtime: MadaraRuntimeConfig,
  buildPath: (page: number) => string,
  pagination: Pagination,
): Promise<Mangas[]> {
  const limit = Math.max(0, pagination.limit);
  const offset = Math.max(0, pagination.offset);

  if (limit === 0) {
    return [];
  }

  const startPage = Math.floor(offset / runtime.sitePageSize) + 1;
  let page = startPage;
  let skipInPage = offset % runtime.sitePageSize;

  const collected: Mangas[] = [];

  while (collected.length < limit) {
    let html: string;
    try {
      html = await fetchSourceHtml(
        config.id,
        config.name,
        config.api,
        config.baseUrl,
        buildPath(page),
        runtime.waitSelector,
        runtime.cacheTtlMs,
        runtime.useAntiDetection,
      );
    } catch (error) {
      // The very first page must succeed — that's a real failure the caller needs to
      // see. Beyond that, a failing "next page" (e.g. a 404 past the last real page) is
      // just the normal end of pagination, same as an empty page.
      if (collected.length === 0 && page === startPage) {
        throw error;
      }
      break;
    }

    const $ = cheerio.load(html);
    const pageItems = parseBrowseItems($, selectors, config.id, config.baseUrl);

    if (pageItems.length === 0) {
      break;
    }

    const remaining = limit - collected.length;
    const chunk = pageItems.slice(skipInPage, skipInPage + remaining);
    collected.push(...chunk);

    if (pageItems.length <= skipInPage) {
      break;
    }

    skipInPage = 0;
    page++;
  }

  return collected;
}

/**
 * Builds a `Source` for a site running the Madara WordPress theme from theme-specific
 * selectors and path builders. `config.selectors` and `config.runtime` override
 * `DEFAULT_SELECTORS`/`DEFAULT_RUNTIME`, which assume an unmodified theme install.
 */
export function createMadaraSource(config: MadaraSourceConfig): Source {
  const selectors: MadaraSelectors = {
    ...DEFAULT_SELECTORS,
    ...(config.selectors || {}),
  };

  const runtime: MadaraRuntimeConfig = {
    ...DEFAULT_RUNTIME,
    ...(config.runtime || {}),
  };

  const buildBrowsePath =
    config.buildBrowsePath || ((category, page) => defaultBrowsePath(category, page));
  const buildSearchPath =
    config.buildSearchPath || ((query, page) => defaultSearchPath(query, page));
  const buildMangaPath = config.buildMangaPath || defaultMangaPath;
  const buildChapterPath = config.buildChapterPath || defaultChapterPath;

  return {
    id: config.id,
    name: config.name,
    lang: config.lang,
    base_url: config.baseUrl,
    isNSFW: config.isNSFW,

    async fetchManga(
      category,
      pagination: Pagination,
      filters: Record<string, FilterValue>,
    ): Promise<Mangas[]> {
      return fetchPagedManga(
        config,
        selectors,
        runtime,
        (page) => buildBrowsePath(category, page, filters || {}),
        pagination,
      );
    },

    async searchManga(
      query,
      pagination: Pagination,
      filters: Record<string, FilterValue>,
    ): Promise<Mangas[]> {
      return fetchPagedManga(
        config,
        selectors,
        runtime,
        (page) => buildSearchPath(query, page, filters || {}),
        pagination,
      );
    },

    async fetchMangaDetails(mangaId: string): Promise<MangaDetails> {
      const html = await fetchSourceHtml(
        config.id,
        config.name,
        config.api,
        config.baseUrl,
        buildMangaPath(mangaId),
        runtime.waitSelector,
        runtime.cacheTtlMs,
        runtime.useAntiDetection,
      );

      const $ = cheerio.load(html);

      const title = normalizeText($(selectors.detailsTitle).first().text()) || 'No Title';
      const thumbnailRaw =
        $(selectors.detailsThumbnail).first().attr('data-src') ||
        $(selectors.detailsThumbnail).first().attr('data-lazy-src') ||
        $(selectors.detailsThumbnail).first().attr('src') ||
        '';

      const author = $(selectors.detailsAuthor)
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean);

      const genres = $(selectors.detailsGenres)
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean);

      const description = normalizeText($(selectors.detailsDescription).first().text());
      const statusRaw = normalizeText($(selectors.detailsStatus).first().text());
      const chapters = await this.fetchChapters(mangaId);

      return {
        source: config.id,
        id: mangaId,
        slug: mangaId,
        url: toAbsoluteUrl(buildMangaPath(mangaId), config.baseUrl),
        title,
        thumbnail_url: toAbsoluteUrl(thumbnailRaw, config.baseUrl),
        description,
        author,
        genres,
        status: mapMangaStatus(statusRaw),
        chapters,
      };
    },

    async fetchChapters(mangaId: string): Promise<Chapters[]> {
      const html = await fetchSourceHtml(
        config.id,
        config.name,
        config.api,
        config.baseUrl,
        buildMangaPath(mangaId),
        runtime.waitSelector,
        runtime.cacheTtlMs,
        runtime.useAntiDetection,
      );

      const $ = cheerio.load(html);

      const chapters = $(selectors.chapterItem)
        .map((index, el) => {
          const node = $(el);
          const linkNode = node.find(selectors.chapterLink).first();
          const href = linkNode.attr('href') || '';

          const chapterKey = extractChapterKey(href);
          if (!chapterKey) {
            return null;
          }

          const rawName =
            normalizeText(node.find(selectors.chapterName).first().text()) ||
            normalizeText(linkNode.text());
          const chapterNumber = parseChapterNumber(rawName, index + 1);

          const dateNode = node.find(selectors.chapterDate).first();
          const rawDate =
            dateNode.attr('datetime') ||
            dateNode.attr('title') ||
            normalizeText(dateNode.text()) ||
            '';

          const chapterId = `${mangaId}-${chapterKey}`;

          return {
            id: chapterId,
            name: rawName || `Chapter ${index + 1}`,
            url: toAbsoluteUrl(href, config.baseUrl),
            chapter_number: chapterNumber,
            scanlator: 'Unknown',
            language: config.lang,
            last_page_read: 0,
            release_date: parseDateToIso(rawDate),
            page_count: 0,
            pages: [],
          } as Chapters;
        })
        .get()
        .filter((chapter): chapter is Chapters => chapter !== null);

      return chapters;
    },

    async fetchChapterPages(
      chapterId: string,
      mangaSlug?: string,
      pagination?: Pagination,
    ): Promise<ChapterPagesResult<Page>> {
      const chapterKeyFromId = chapterId.replace(`${mangaSlug || ''}-`, '');
      const chapterPath =
        chapterId.startsWith('http://') || chapterId.startsWith('https://')
          ? chapterId
          : buildChapterPath(chapterKeyFromId, mangaSlug);

      const path =
        chapterPath.startsWith('http://') || chapterPath.startsWith('https://')
          ? chapterPath.replace(config.baseUrl, '')
          : chapterPath;

      const html = await fetchSourceHtml(
        config.id,
        config.name,
        config.api,
        config.baseUrl,
        path,
        runtime.waitSelector,
        runtime.cacheTtlMs,
        runtime.useAntiDetection,
      );

      const $ = cheerio.load(html);

      const imageUrls = $(selectors.pageImage)
        .map((_, el) => {
          const node = $(el);
          return (
            node.attr('data-src') ||
            node.attr('data-lazy-src') ||
            node.attr('data-original') ||
            node.attr('src') ||
            ''
          );
        })
        .get()
        .map((url) => toAbsoluteUrl(url.trim(), config.baseUrl))
        .filter((url) => {
          const lower = url.toLowerCase();
          return url.startsWith('http') && !lower.includes('credits') && !lower.includes('logo');
        });

      const uniqueImageUrls = Array.from(new Set(imageUrls));
      const total = uniqueImageUrls.length;

      if (total === 0) {
        // The page loaded but no page images matched — almost certainly the site
        // changed its markup rather than a genuinely empty chapter.
        throw new SourceError(
          'PARSE_ERROR',
          `${config.name} returned no readable pages for this chapter — it may have changed its layout.`,
          config.id,
        );
      }

      const limit = Math.max(1, pagination?.limit ?? total);
      const offset = Math.max(0, pagination?.offset ?? 0);
      const start = Math.min(offset, total);
      const end = Math.min(start + limit, total);

      const items: Page[] = uniqueImageUrls.slice(start, end).map((imageUrl, idx) => ({
        index: start + idx + 1,
        image_url: imageUrl,
      }));

      return { items, total };
    },

    async getFilters(): Promise<MangaFilter[]> {
      if (config.getFilters) {
        return await config.getFilters();
      }
      return [];
    },

    async fetchMangaUpdates(mangaSlug: string): Promise<Chapters[]> {
      if (config.fetchMangaUpdates) {
        return config.fetchMangaUpdates(mangaSlug);
      }
      return this.fetchChapters(mangaSlug);
    },
  };
}
