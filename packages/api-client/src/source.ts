import type {
  Mangas,
  MangaDetails,
  MangaFilter,
  Pagination,
  FilterValue,
  Page,
  ChapterPagesResult,
  SourceCataloguePage,
  SourcePageRequest,
  SourceCapabilities,
  SourceBrowserSessionStatus,
} from '@projekt-manga/types';
import type { SourceBrowserSessionBody } from '@projekt-manga/schemas';
import { request, buildApiUrl } from './client.js';

export interface SourceSummary {
  id: string;
  name: string;
  lang: string;
  base_url: string;
  isNSFW: boolean;
  /** Where the source runs: an installed extension, or a connected Suwayomi server. Older
   * servers omit it, which means an extension. */
  provider?: 'extension' | 'suwayomi';
  /** The source's own icon, for sources without an installed extension record. */
  icon_url?: string | null;
}

export interface SourceOperationHealth {
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  retryAfterAt: string | null;
}

export interface SourceHealth {
  sourceId: string;
  browse: SourceOperationHealth | null;
  update: SourceOperationHealth | null;
}

export interface FetchMangaUpdatesResult {
  newChapters: number;
  /** The new chapters, for auto-download. Absent from older servers. */
  newChapterList?: Array<{
    source_chapter_key: string;
    chapter_number: number;
    name: string | null;
  }>;
  /** Stored chapters relinked to a new source id, updated or removed — changes to the
   * list that are not new chapters. Older servers omit it. */
  changedChapters?: number;
  thumbnail_url: string;
  /** Older servers omit this field; only true identifies a failed source check. */
  failed?: boolean;
}

const encode = (value: string) => encodeURIComponent(value);

function filtersQuery(filters?: Record<string, FilterValue>): string | undefined {
  return filters && Object.keys(filters).length > 0 ? JSON.stringify(filters) : undefined;
}

export const getSources = (signal?: AbortSignal) =>
  request<SourceSummary[]>('/source/sources', { signal });

export const getSourceHealth = (signal?: AbortSignal) =>
  request<SourceHealth[]>('/source/health', { signal });

/** Every source's capabilities at once; a source that failed is missing from the result. */
export const getAllSourceCapabilities = (signal?: AbortSignal) =>
  request<Record<string, SourceCapabilities>>('/source/capabilities', { signal });

export const getSourceCapabilities = (sourceId: string, signal?: AbortSignal) =>
  request<SourceCapabilities>(`/source/${encode(sourceId)}/capabilities`, { signal });

export const getSourceMangaPage = (
  sourceId: string,
  params: SourcePageRequest & { category?: string; filters?: Record<string, FilterValue> } = {},
  signal?: AbortSignal,
) =>
  request<SourceCataloguePage>(`/source/${encode(sourceId)}/catalogue`, {
    query: {
      category: params.category,
      cursor: params.cursor,
      limit: params.limit,
      filters: filtersQuery(params.filters),
    },
    signal,
  });

export const searchSourceMangaPage = (
  sourceId: string,
  params: SourcePageRequest & { query?: string; filters?: Record<string, FilterValue> } = {},
  signal?: AbortSignal,
) =>
  request<SourceCataloguePage>(`/source/${encode(sourceId)}/search-page`, {
    query: {
      query: params.query,
      cursor: params.cursor,
      limit: params.limit,
      filters: filtersQuery(params.filters),
    },
    signal,
  });

export const getSourceManga = (
  sourceId: string,
  params: {
    category?: string;
    pagination?: Pagination;
    filters?: Record<string, FilterValue>;
  } = {},
  signal?: AbortSignal,
) =>
  request<Mangas[]>(`/source/${encode(sourceId)}/manga`, {
    query: {
      category: params.category,
      limit: params.pagination?.limit,
      offset: params.pagination?.offset,
      filters: filtersQuery(params.filters),
    },
    signal,
  });

export const searchSourceManga = (
  sourceId: string,
  params: { query?: string; pagination?: Pagination; filters?: Record<string, FilterValue> } = {},
  signal?: AbortSignal,
) =>
  request<Mangas[]>(`/source/${encode(sourceId)}/search`, {
    query: {
      query: params.query,
      limit: params.pagination?.limit,
      offset: params.pagination?.offset,
      filters: filtersQuery(params.filters),
    },
    signal,
  });

export const getSourceMangaDetails = (sourceId: string, mangaId: string, signal?: AbortSignal) =>
  request<MangaDetails>(`/source/${encode(sourceId)}/manga/${encode(mangaId)}`, { signal });

export const getSourceMangaThumbnail = (sourceId: string, mangaId: string, signal?: AbortSignal) =>
  request<{ thumbnail_url: string }>(
    `/source/${encode(sourceId)}/manga/${encode(mangaId)}/thumbnail`,
    {
      signal,
    },
  );

export const getSourceChapterPages = (
  sourceId: string,
  chapterId: string,
  params: { mangaSlug?: string; pagination?: Pagination } = {},
  signal?: AbortSignal,
) =>
  request<ChapterPagesResult<Page>>(
    `/source/${encode(sourceId)}/chapter/${encode(chapterId)}/pages`,
    {
      query: {
        manga_slug: params.mangaSlug,
        limit: params.pagination?.limit,
        offset: params.pagination?.offset,
      },
      signal,
    },
  );

export const getSourceFilters = (sourceId: string, signal?: AbortSignal) =>
  request<MangaFilter[]>(`/source/${encode(sourceId)}/filters`, { signal });

export const fetchSourceMangaUpdates = (
  sourceId: string,
  mangaSlug: string,
  mangaId?: string,
  signal?: AbortSignal,
) =>
  request<FetchMangaUpdatesResult>(
    `/source/${encode(sourceId)}/manga/${encode(mangaSlug)}/updates`,
    {
      method: 'POST',
      body: { manga_id: mangaId },
      signal,
    },
  );

export interface CheckLibraryUpdatesResult {
  checked: number;
  mangaWithNewChapters: number;
  totalNewChapters: number;
}

/** Checks every manga currently in the library against its source for new chapters. */
export const checkLibraryUpdates = () =>
  request<CheckLibraryUpdatesResult>('/source/library/check-updates', { method: 'POST' });

/** URL for an <img src> — not fetched through request(), the response body is the image
 * itself, not a JSON envelope. */
export const buildImageProxyUrl = (targetUrl: string, sourceId?: string) =>
  buildApiUrl('/source/image-proxy', { url: targetUrl, source_id: sourceId });

/** What the server holds for a source's browser session (never the cookies). Admin-only. */
export const getSourceBrowserSession = (sourceId: string, signal?: AbortSignal) =>
  request<SourceBrowserSessionStatus>(`/source/${encode(sourceId)}/browser-session`, { signal });

/** Replaces the source's browser session with cookies the reader copied from their own
 * browser. Admin-only. The desktop window saves from its main process instead, so its
 * cookies never pass through a page. */
export const saveSourceBrowserSession = (sourceId: string, body: SourceBrowserSessionBody) =>
  request<SourceBrowserSessionStatus>(`/source/${encode(sourceId)}/browser-session`, {
    method: 'PUT',
    body,
  });

/** Forgets the cookies saved for this source. Admin-only. */
export const clearSourceBrowserSession = (sourceId: string) =>
  request<null>(`/source/${encode(sourceId)}/browser-session`, { method: 'DELETE' });

export interface SourceUrlKeys {
  /** False when the source cannot convert Mihon URLs at all. */
  supported: boolean;
  /** One title slug per requested manga URL, in order; null where unrecognised. */
  manga: Array<string | null>;
  /** One chapter key per requested chapter URL, in order; null where unrecognised. */
  chapters: Array<string | null>;
}

/** Converts Mihon/Tachiyomi URLs into this source's slugs and chapter keys. At most
 * `SOURCE_URL_KEYS_LIMIT` URLs per call. */
export const getSourceKeysFromUrls = (
  sourceId: string,
  urls: { manga: string[]; chapters: string[] },
  signal?: AbortSignal,
) =>
  request<SourceUrlKeys>(`/source/${encode(sourceId)}/keys-from-urls`, {
    method: 'POST',
    body: urls,
    signal,
  });
