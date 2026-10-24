export interface Mangas {
  /** The *source's own* identifier for this title — pass it back into that same source's
   * `fetchMangaDetails`/`fetchChapters`, not into an endpoint expecting a database id. This
   * is a different value space from api-client's `Manga.id` (the internal database id)
   * until `AddMangaPayload` persists the title and a real database row exists. */
  id: string;
  slug: string;
  title: string;
  source: string;
  thumbnail_url: string;
}

export interface MangaDetails extends Mangas {
  /** The title's page on the source site (absolute, or relative to the source's `base_url`).
   * Optional: the app can't derive it, since series URL layouts differ per source. */
  url?: string;
  author?: string[];
  artist?: string[];
  groups?: string[];
  description: string;
  genres: string[];
  status: string;
  chapters: Chapters[];
}

export interface Chapters {
  id: string;
  name: string;
  url: string;
  chapter_number: number;
  scanlator?: string;
  is_read?: boolean;
  is_bookmark?: boolean;
  last_page_read: number;
  fetched_at?: string;
  release_date: string;
  page_count?: number;
  language?: string;
  /** Always `[]` as returned from `fetchChapters`/`fetchManga*` — real page URLs only
   * come from a separate `fetchChapterPages` call. */
  pages: Page[];
}

export interface Page {
  index: number;
  image_url: string | undefined;
}

export interface ChapterPagesResult<T> {
  items: T[];
  total: number;
}

export type Pagination = { limit: number; offset: number };
export interface SourcePageRequest {
  cursor?: string;
  limit?: number;
}

export interface SourceCataloguePage {
  items: Mangas[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SourceCapabilities {
  latest: boolean;
  search: boolean;
  filters: boolean;
  languageFilter: boolean;
  urlSearch: boolean;
  nativePagination: boolean;
}
/** A tri-state filter's selections — e.g. "include this genre" vs "exclude it"
 * (apps/extensions/sources/mangadex/index.ts's `mergeTagFilters` reads this shape). */
export type TriStateFilterValue = { include?: string[]; exclude?: string[] };
export type FilterValue = string | number | boolean | string[] | TriStateFilterValue;
export type Option = { label: string; value: string };

export interface MangaFilter {
  label: string;
  value: string;
  type: 'input' | 'select' | 'checkbox' | 'radio' | 'multi' | 'tri-state';
  options?: Option[];
}

/**
 * The manga-source extension contract. Implemented by apps/extensions/sources/*,
 * consumed by apps/server. Kept type-only on both sides (`import type`) so this
 * package never needs a build step for either app to run in production.
 */
export interface Source {
  id: string;
  name: string;
  lang: string;
  base_url: string;
  isNSFW: boolean;

  getCapabilities?(): Promise<SourceCapabilities>;
  fetchMangaPage?(
    category?: string,
    pagination?: SourcePageRequest,
    filters?: Record<string, FilterValue>,
  ): Promise<SourceCataloguePage>;
  searchMangaPage?(
    query?: string,
    pagination?: SourcePageRequest,
    filters?: Record<string, FilterValue>,
  ): Promise<SourceCataloguePage>;
  resolveMangaUrl?(url: string): Promise<Mangas | null>;

  fetchManga(
    category?: string,
    pagination?: Pagination,
    filters?: Record<string, FilterValue>,
  ): Promise<Mangas[]>;

  searchManga(
    query?: string,
    pagination?: Pagination,
    filters?: Record<string, FilterValue>,
  ): Promise<Mangas[]>;

  fetchMangaDetails(manga_id: string): Promise<MangaDetails>;

  fetchMangaThumbnail?(manga_id: string): Promise<string>;

  fetchChapters(manga_id: string): Promise<Chapters[]>;

  fetchChapterPages(
    chapter_id: string,
    manga_slug?: string,
    pagination?: Pagination,
  ): Promise<ChapterPagesResult<Page>>;

  getFilters(): Promise<MangaFilter[]>;

  /**
   * Returns the source's current chapter list for the given manga so the caller can diff
   * against what's already stored. Extensions must not persist anything themselves.
   */
  fetchMangaUpdates(manga_slug: string): Promise<Chapters[]>;
}

/**
 * Classifies why a source call failed, so the server (and ultimately the end user) can
 * see "this source is blocking us" instead of a bare empty result. Sources throw a
 * `SourceError` (apps/extensions/sourceError.ts) carrying one of these codes;
 * apps/server's source.service.ts maps each code onto an HTTP status + user-facing
 * message. Kept here (type-only) so both sides agree on the same set of codes without
 * either depending on the other's runtime code.
 */
export type SourceErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'BLOCKED'
  | 'RATE_LIMITED'
  | 'PARSE_ERROR'
  | 'UPSTREAM_ERROR';
