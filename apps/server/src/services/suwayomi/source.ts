import type {
  Chapters,
  ChapterPagesResult,
  FilterValue,
  MangaDetails,
  MangaFilter,
  Mangas,
  Page,
  Pagination,
  Source,
  SourceCapabilities,
  SourceCataloguePage,
  SourcePageRequest,
} from '@projekt-manga/types';
import {
  absoluteSuwayomiUrl,
  requireConnection,
  SuwayomiError,
  suwayomiGraphql,
} from './client.js';
import {
  FILTERS_SELECTION,
  toFilterChanges,
  toMangaFilters,
  type SuwayomiFilter,
} from './filters.js';

/**
 * One source on the host's Suwayomi server, as this app's `Source`.
 *
 * The id is `suwayomi-<Suwayomi source id>`, which no extension may use. A title's slug and
 * a chapter's key are Suwayomi's own manga and chapter ids: they only mean something on that
 * server, which is also the only place their pages can be read from.
 */

export const SUWAYOMI_PREFIX = 'suwayomi-';

export interface SuwayomiSourceInfo {
  id: string;
  name: string;
  lang: string;
  iconUrl: string | null;
  isNsfw: boolean;
  supportsLatest: boolean;
  baseUrl: string | null;
}

interface SuwayomiManga {
  id: number;
  title: string;
  thumbnailUrl: string | null;
}

interface SuwayomiMangaDetails extends SuwayomiManga {
  url: string | null;
  realUrl: string | null;
  author: string | null;
  artist: string | null;
  description: string | null;
  genre: string[] | null;
  status: string | null;
}

interface SuwayomiChapter {
  id: number;
  name: string | null;
  url: string | null;
  realUrl: string | null;
  chapterNumber: number | null;
  scanlator: string | null;
  uploadDate: string | number | null;
  sourceOrder: number | null;
}

const FILTERS_TTL_MS = 10 * 60 * 1000;
const MAX_PAGE = 10_000;
/** How many Suwayomi pages the offset-based `fetchManga`/`searchManga` read at most. */
const MAX_LEGACY_PAGES = 5;

const MANGA_FIELDS = 'id title thumbnailUrl';
const DETAILS_FIELDS = `${MANGA_FIELDS} url realUrl author artist description genre status`;
const CHAPTER_FIELDS = 'id name url realUrl chapterNumber scanlator uploadDate sourceOrder';

const FETCH_SOURCE_MANGA = `mutation ($input: FetchSourceMangaInput!) {
  fetchSourceManga(input: $input) { hasNextPage mangas { ${MANGA_FIELDS} } }
}`;
const SOURCE_FILTERS = `query ($id: LongString!) { source(id: $id) { ${FILTERS_SELECTION} } }`;
const FETCH_MANGA = `mutation ($input: FetchMangaInput!) {
  fetchManga(input: $input) { manga { ${DETAILS_FIELDS} } }
}`;
const FETCH_CHAPTERS = `mutation ($input: FetchChaptersInput!) {
  fetchChapters(input: $input) { chapters { ${CHAPTER_FIELDS} } }
}`;
const FETCH_PAGES = `mutation ($input: FetchChapterPagesInput!) {
  fetchChapterPages(input: $input) { pages }
}`;

/** Suwayomi ids are integers; anything else is a stale or forged key. */
function suwayomiId(value: string, kind: string): number {
  if (!/^\d{1,10}$/.test(value)) throw new SuwayomiError('NOT_FOUND', `No such Suwayomi ${kind}`);
  return Number(value);
}

function pageNumber(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  const page = /^\d{1,5}$/.test(cursor) ? Number(cursor) : NaN;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    const error = new SuwayomiError('PARSE_ERROR', 'Invalid catalogue cursor');
    Object.assign(error, { reason: 'INVALID_CURSOR' });
    throw error;
  }
  return page;
}

function releaseDate(value: string | number | null): string {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : '';
}

const splitPeople = (value: string | null) =>
  value
    ? value
        .split(/\s*,\s*/)
        .map((name) => name.trim())
        .filter(Boolean)
    : [];

export function createSuwayomiSource(info: SuwayomiSourceInfo): Source {
  const id = `${SUWAYOMI_PREFIX}${info.id}`;
  let filterCache: { at: number; filters: SuwayomiFilter[] } | null = null;

  const toManga = (manga: SuwayomiManga): Mangas => ({
    id: String(manga.id),
    slug: String(manga.id),
    title: manga.title || 'Untitled',
    source: id,
    thumbnail_url: absoluteSuwayomiUrl(manga.thumbnailUrl, requireConnection()),
  });

  async function sourceFilters(): Promise<SuwayomiFilter[]> {
    if (filterCache && Date.now() - filterCache.at < FILTERS_TTL_MS) return filterCache.filters;
    const data = await suwayomiGraphql<{ source: { filters: SuwayomiFilter[] } | null }>(
      SOURCE_FILTERS,
      { id: info.id },
    );
    if (!data.source) throw new SuwayomiError('NOT_FOUND', 'Suwayomi no longer has this source');
    filterCache = { at: Date.now(), filters: data.source.filters ?? [] };
    return filterCache.filters;
  }

  async function browse(
    type: 'POPULAR' | 'LATEST' | 'SEARCH',
    page: number,
    query?: string,
    filters?: Record<string, FilterValue>,
  ): Promise<{ items: Mangas[]; hasNextPage: boolean }> {
    const hasFilters = Boolean(filters && Object.keys(filters).length > 0);
    // Mihon sources apply filters to search only, so a filtered browse is a blank search.
    const effectiveType = hasFilters || query ? 'SEARCH' : type;
    const changes = hasFilters ? toFilterChanges(await sourceFilters(), filters) : [];
    const data = await suwayomiGraphql<{
      fetchSourceManga: { hasNextPage: boolean; mangas: SuwayomiManga[] };
    }>(FETCH_SOURCE_MANGA, {
      input: {
        source: info.id,
        type: effectiveType,
        page,
        ...(effectiveType === 'SEARCH' ? { query: query ?? '' } : {}),
        ...(changes.length > 0 ? { filters: changes } : {}),
      },
    });
    const result = data.fetchSourceManga;
    return {
      items: (result?.mangas ?? []).map(toManga),
      hasNextPage: Boolean(result?.hasNextPage),
    };
  }

  async function cataloguePage(
    type: 'POPULAR' | 'LATEST' | 'SEARCH',
    pagination: SourcePageRequest | undefined,
    query?: string,
    filters?: Record<string, FilterValue>,
  ): Promise<SourceCataloguePage> {
    const page = pageNumber(pagination?.cursor);
    const { items, hasNextPage } = await browse(type, page, query, filters);
    const hasMore = hasNextPage && items.length > 0 && page < MAX_PAGE;
    return {
      items: items.slice(0, 200),
      hasMore,
      ...(hasMore ? { nextCursor: String(page + 1) } : {}),
    };
  }

  /** The offset-based calls, read off Suwayomi's numbered pages. */
  async function offsetPage(
    type: 'POPULAR' | 'LATEST' | 'SEARCH',
    pagination: Pagination | undefined,
    query?: string,
    filters?: Record<string, FilterValue>,
  ): Promise<Mangas[]> {
    const offset = Math.max(0, pagination?.offset ?? 0);
    const limit = Math.max(1, pagination?.limit ?? 20);
    const collected: Mangas[] = [];
    for (let page = 1; page <= MAX_LEGACY_PAGES; page++) {
      const { items, hasNextPage } = await browse(type, page, query, filters);
      collected.push(...items);
      if (collected.length >= offset + limit || !hasNextPage || items.length === 0) break;
    }
    return collected.slice(offset, offset + limit);
  }

  async function chapters(mangaSlug: string): Promise<Chapters[]> {
    const data = await suwayomiGraphql<{ fetchChapters: { chapters: SuwayomiChapter[] } }>(
      FETCH_CHAPTERS,
      { input: { mangaId: suwayomiId(mangaSlug, 'title') } },
    );
    const list = [...(data.fetchChapters?.chapters ?? [])];
    // Newest first, like the extensions: Suwayomi numbers the source's order oldest-first.
    list.sort((a, b) => (b.sourceOrder ?? 0) - (a.sourceOrder ?? 0));
    return list.map((chapter) => ({
      id: String(chapter.id),
      name: chapter.name ?? '',
      url: chapter.realUrl || chapter.url || '',
      chapter_number:
        typeof chapter.chapterNumber === 'number' && Number.isFinite(chapter.chapterNumber)
          ? chapter.chapterNumber
          : -1,
      ...(chapter.scanlator ? { scanlator: chapter.scanlator } : {}),
      last_page_read: 0,
      release_date: releaseDate(chapter.uploadDate),
      pages: [],
    }));
  }

  return {
    id,
    name: info.name,
    lang: info.lang,
    base_url: info.baseUrl ?? '',
    isNSFW: info.isNsfw,

    async getCapabilities(): Promise<SourceCapabilities> {
      return {
        latest: info.supportsLatest,
        search: true,
        filters: true,
        languageFilter: false,
        urlSearch: false,
        nativePagination: true,
      };
    },

    fetchMangaPage: (category, pagination, filters) =>
      cataloguePage(
        category === 'latest' && info.supportsLatest ? 'LATEST' : 'POPULAR',
        pagination,
        undefined,
        filters,
      ),
    searchMangaPage: (query, pagination, filters) =>
      cataloguePage('SEARCH', pagination, query?.trim() ?? '', filters),
    fetchManga: (category, pagination, filters) =>
      offsetPage(
        category === 'latest' && info.supportsLatest ? 'LATEST' : 'POPULAR',
        pagination,
        undefined,
        filters,
      ),
    searchManga: (query, pagination, filters) =>
      offsetPage('SEARCH', pagination, query?.trim() ?? '', filters),

    async fetchMangaDetails(mangaId: string): Promise<MangaDetails> {
      const data = await suwayomiGraphql<{ fetchManga: { manga: SuwayomiMangaDetails | null } }>(
        FETCH_MANGA,
        { input: { id: suwayomiId(mangaId, 'title') } },
      );
      const manga = data.fetchManga?.manga;
      if (!manga) throw new SuwayomiError('NOT_FOUND', 'Suwayomi has no such title');
      return {
        ...toManga(manga),
        ...(manga.realUrl ? { url: manga.realUrl } : {}),
        author: splitPeople(manga.author),
        artist: splitPeople(manga.artist),
        description: manga.description ?? '',
        genres: (manga.genre ?? []).filter((genre) => typeof genre === 'string' && genre),
        status: manga.status ?? '',
        chapters: await chapters(mangaId),
      };
    },

    async fetchMangaThumbnail(mangaId: string): Promise<string> {
      return absoluteSuwayomiUrl(
        `/api/v1/manga/${suwayomiId(mangaId, 'title')}/thumbnail`,
        requireConnection(),
      );
    },

    fetchChapters: chapters,
    fetchMangaUpdates: chapters,

    async fetchChapterPages(
      chapterId: string,
      _mangaSlug?: string,
      pagination?: Pagination,
    ): Promise<ChapterPagesResult<Page>> {
      const data = await suwayomiGraphql<{ fetchChapterPages: { pages: string[] } }>(FETCH_PAGES, {
        input: { chapterId: suwayomiId(chapterId, 'chapter') },
      });
      const connection = requireConnection();
      const all = (data.fetchChapterPages?.pages ?? []).map((path, index) => ({
        index,
        image_url: absoluteSuwayomiUrl(path, connection) || undefined,
      }));
      const items = pagination
        ? all.slice(pagination.offset, pagination.offset + pagination.limit)
        : all;
      return { items, total: all.length };
    },

    async getFilters(): Promise<MangaFilter[]> {
      return toMangaFilters(await sourceFilters());
    },
  };
}
