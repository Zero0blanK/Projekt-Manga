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
} from '@projekt-manga/types';
import { request, buildApiUrl } from './client.js';

export interface SourceSummary {
  id: string;
  name: string;
  lang: string;
  base_url: string;
  isNSFW: boolean;
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
