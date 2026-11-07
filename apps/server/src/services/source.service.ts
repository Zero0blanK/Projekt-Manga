import type {
  Mangas,
  MangaDetails,
  MangaFilter,
  Pagination,
  FilterValue,
  Page,
  ChapterPagesResult,
  SourceErrorCode,
  SourceCapabilities,
  SourceCataloguePage,
  SourcePageRequest,
} from '@projekt-manga/types';
import { z } from 'zod';
import {
  sourceMangaListSchema,
  sourceMangaDetailsSchema,
  sourceChapterListSchema,
  sourceChapterPagesSchema,
  sourceMangaFilterListSchema,
  sourceCapabilitiesSchema,
  sourceCataloguePageSchema,
} from '@projekt-manga/schemas';
import type { SandboxedSource, UrlKeysResult } from '@projekt-manga/extensions/sandbox';
import type { SourceUrlKeysBody } from '@projekt-manga/schemas';
import { getInstalledSandboxedSources } from './sandboxedSourceRegistry.service.js';
import { resolveSource } from './sourceResolver.service.js';
import { announceLibraryChange, EVERYONE } from '../utils/libraryChanges.js';
import { getSuwayomiSourceSummaries } from './suwayomi/registry.js';
import chapterService from './chapter.service.js';
import type { AddedChapter } from '../repositories/chapter.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import libraryService from './library.service.js';
import updateLogService from './updateLog.service.js';
import { recordSourceAttempt, recordSourceOperation } from './sourceHealth.service.js';
import {
  ServiceUnavailableError,
  ChallengeRequiredError,
  TimeoutError,
  NotFoundError,
  RateLimitedError,
  UpstreamError,
  ValidationError,
} from '../utils/customErrors.js';

/**
 * Checks what a source handed back before any of it is used.
 *
 * A source is third-party code installed from a user-added repository. The sandbox denies
 * it the filesystem, the environment and the network, but says nothing about the shape of
 * its *return* values — and the `Promise<Mangas[]>` annotations in this file are erased at
 * runtime, so without this they would be unchecked casts of arbitrary JSON into the API's
 * responses and the reader's UI.
 *
 * Reported as UPSTREAM_ERROR through the same path a source's own thrown errors take, so a
 * source returning nonsense reads as "this source is broken" — which it is — instead of an
 * unexplained 500 or, worse, a half-rendered page. The source id is in the message because
 * with several installed, "which one" is the first question worth answering.
 *
 * The schemas themselves are intentionally forgiving (see packages/schemas/sourceOutput.ts):
 * this is here to catch malformed output, not to enforce spec compliance on sources nobody
 * can patch from inside the app.
 */
// Generic over the schema rather than its result: these schemas apply defaults and
// transforms, so their input and output types differ, and `z.ZodType<T>` would resolve T to
// the *input* side — reintroducing exactly the optionality the parse is meant to remove.
function parseSourceOutput<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  sourceId: string,
  method: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new UpstreamError(
      `Source "${sourceId}" returned data this app could not read from ${method}: ${result.error.message}`,
    );
  }
  return result.data;
}

interface SourceErrorLike {
  code: SourceErrorCode;
  message: string;
  reason?: unknown;
}

function isSourceErrorLike(error: unknown): error is SourceErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

function sourceHealthFailure(error: unknown): {
  success: false;
  code: SourceErrorCode | 'UNCLASSIFIED';
  retryAfterMs?: number;
} {
  if (!isSourceErrorLike(error)) return { success: false, code: 'UNCLASSIFIED' };
  const reasonValue = (error as unknown as { reason?: unknown }).reason;
  const reason = typeof reasonValue === 'string' ? reasonValue : '';
  const retryAfterSeconds = /retry after (\d+(?:\.\d+)?)s/i.exec(reason)?.[1];
  const retryAfterMs = retryAfterSeconds ? Number(retryAfterSeconds) * 1000 : undefined;
  return {
    success: false,
    code: error.code,
    ...(retryAfterMs && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  };
}

/**
 * Maps a classified error thrown by a source (apps/extensions/sourceError.ts) onto the
 * right HTTP status + a message that's safe (and useful) to show the end user — "this
 * source is blocking requests" instead of a generic 500. Falls back to rethrowing
 * anything unrecognized unchanged.
 */
function translateSourceError(error: unknown): never {
  if (isSourceErrorLike(error)) {
    switch (error.code) {
      case 'NETWORK_ERROR':
        throw new ServiceUnavailableError(error.message);
      case 'TIMEOUT':
        throw new TimeoutError(error.message);
      case 'NOT_FOUND':
        throw new NotFoundError(error.message);
      case 'RATE_LIMITED':
        throw new RateLimitedError(error.message);
      case 'BLOCKED':
        throw new ServiceUnavailableError(error.message);
      case 'CHALLENGE_REQUIRED':
        throw new ChallengeRequiredError(error.message);
      case 'PARSE_ERROR':
        if (error.reason === 'INVALID_CURSOR' || error.reason === 'INVALID_PAGINATION') {
          throw new ValidationError('Invalid catalogue pagination. Restart the search or browse.');
        }
        throw new UpstreamError(error.message);
      case 'UPSTREAM_ERROR':
        throw new UpstreamError(error.message);
    }
  }
  throw error;
}

const getSourceById = async (sourceId: string) => {
  const source = await resolveSource(sourceId);
  if (!source) {
    throw new ServiceUnavailableError(`Source not found: ${sourceId}`);
  }
  return source;
};

const getSources = async () => {
  const [installed, suwayomi] = await Promise.all([
    getInstalledSandboxedSources(),
    getSuwayomiSourceSummaries(),
  ]);
  return [
    ...installed.map((source) => ({
      id: source.id,
      name: source.name,
      lang: source.lang,
      base_url: source.base_url,
      isNSFW: source.isNSFW,
      provider: 'extension' as const,
    })),
    ...suwayomi,
  ];
};

const getManga = async (params: {
  sourceId: string;
  category: string;
  pagination: Pagination;
  filters?: Record<string, FilterValue>;
}): Promise<Mangas[]> => {
  const source = await getSourceById(params.sourceId);
  recordSourceAttempt(params.sourceId, 'browse');
  try {
    const result = await source.fetchManga(
      params.category,
      params.pagination,
      params.filters || {},
    );
    const parsed = parseSourceOutput(sourceMangaListSchema, result, params.sourceId, 'fetchManga');
    recordSourceOperation(params.sourceId, 'browse', { success: true });
    return parsed;
  } catch (error) {
    recordSourceOperation(params.sourceId, 'browse', sourceHealthFailure(error));
    translateSourceError(error);
  }
};

const searchManga = async (params: {
  sourceId: string;
  query: string;
  pagination: Pagination;
  filters?: Record<string, FilterValue>;
}): Promise<Mangas[]> => {
  const source = await getSourceById(params.sourceId);
  recordSourceAttempt(params.sourceId, 'browse');
  try {
    const result = await source.searchManga(params.query, params.pagination, params.filters || {});
    const parsed = parseSourceOutput(sourceMangaListSchema, result, params.sourceId, 'searchManga');
    recordSourceOperation(params.sourceId, 'browse', { success: true });
    return parsed;
  } catch (error) {
    recordSourceOperation(params.sourceId, 'browse', sourceHealthFailure(error));
    translateSourceError(error);
  }
};

const getCapabilities = async (sourceId: string): Promise<SourceCapabilities> => {
  const source = await getSourceById(sourceId);
  try {
    if (!source.getCapabilities) throw new UpstreamError('Source catalogue runtime is unavailable');
    return parseSourceOutput(
      sourceCapabilitiesSchema,
      await source.getCapabilities(),
      sourceId,
      'getCapabilities',
    );
  } catch (error) {
    translateSourceError(error);
  }
};

/** Every listed source's capabilities in one call; a source that fails is left out, and
 * asking for it alone reports why. */
const getAllCapabilities = async (): Promise<Record<string, SourceCapabilities>> => {
  const sources = await getSources();
  const results = await Promise.allSettled(
    sources.map(async (source) => [source.id, await getCapabilities(source.id)] as const),
  );
  return Object.fromEntries(
    results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
  );
};

const getCataloguePage = async (
  params: {
    sourceId: string;
    category?: string;
    query?: string;
    pagination: SourcePageRequest;
    filters?: Record<string, FilterValue>;
  },
  search = false,
): Promise<SourceCataloguePage> => {
  const source = await getSourceById(params.sourceId);
  recordSourceAttempt(params.sourceId, 'browse');
  try {
    const method = search ? source.searchMangaPage : source.fetchMangaPage;
    if (!method) throw new UpstreamError('Source catalogue runtime is unavailable');
    const result = await method.call(
      source,
      search ? params.query : params.category,
      params.pagination,
      params.filters || {},
    );
    const parsed = parseSourceOutput(
      sourceCataloguePageSchema,
      result,
      params.sourceId,
      search ? 'searchMangaPage' : 'fetchMangaPage',
    );
    if (parsed.hasMore && parsed.nextCursor === params.pagination.cursor) {
      throw new UpstreamError('Source returned a catalogue cursor that did not advance');
    }
    recordSourceOperation(params.sourceId, 'browse', { success: true });
    return parsed;
  } catch (error) {
    recordSourceOperation(params.sourceId, 'browse', sourceHealthFailure(error));
    translateSourceError(error);
  }
};

const getMangaDetails = async (source_id: string, manga_id: string): Promise<MangaDetails> => {
  const source = await getSourceById(source_id);
  recordSourceAttempt(source_id, 'browse');
  try {
    const result = await source.fetchMangaDetails(manga_id);
    const parsed = parseSourceOutput(
      sourceMangaDetailsSchema,
      result,
      source_id,
      'fetchMangaDetails',
    );
    recordSourceOperation(source_id, 'browse', { success: true });
    return parsed;
  } catch (error) {
    recordSourceOperation(source_id, 'browse', sourceHealthFailure(error));
    translateSourceError(error);
  }
};

const getMangaThumbnail = async (source_id: string, manga_id: string): Promise<string> => {
  const source = await getSourceById(source_id);
  recordSourceAttempt(source_id, 'browse');
  try {
    if (typeof source.fetchMangaThumbnail === 'function') {
      const url = await source.fetchMangaThumbnail(manga_id);
      // Narrower than the schemas above because the return value is a bare string; anything
      // else would end up rendered as an image src.
      const thumbnail = typeof url === 'string' ? url : '';
      recordSourceOperation(source_id, 'browse', { success: true });
      return thumbnail;
    }

    const details = parseSourceOutput(
      sourceMangaDetailsSchema,
      await source.fetchMangaDetails(manga_id),
      source_id,
      'fetchMangaDetails',
    );
    recordSourceOperation(source_id, 'browse', { success: true });
    return details.thumbnail_url || '';
  } catch (error) {
    recordSourceOperation(source_id, 'browse', sourceHealthFailure(error));
    translateSourceError(error);
  }
};

const getChapterPages = async (
  source_id: string,
  chapter_id: string,
  manga_slug?: string,
  pagination?: Pagination,
): Promise<ChapterPagesResult<Page>> => {
  const source = await getSourceById(source_id);
  recordSourceAttempt(source_id, 'browse');
  try {
    const result = await source.fetchChapterPages(chapter_id, manga_slug, pagination);
    const parsed = parseSourceOutput(
      sourceChapterPagesSchema,
      result,
      source_id,
      'fetchChapterPages',
    );
    recordSourceOperation(source_id, 'browse', { success: true });
    return parsed;
  } catch (error) {
    recordSourceOperation(source_id, 'browse', sourceHealthFailure(error));
    translateSourceError(error);
  }
};

const getFilters = async (source_id: string): Promise<MangaFilter[]> => {
  const source = await getSourceById(source_id);
  recordSourceAttempt(source_id, 'browse');
  try {
    const result = await source.getFilters();
    const parsed = parseSourceOutput(sourceMangaFilterListSchema, result, source_id, 'getFilters');
    recordSourceOperation(source_id, 'browse', { success: true });
    return parsed;
  } catch (error) {
    recordSourceOperation(source_id, 'browse', sourceHealthFailure(error));
    translateSourceError(error);
  }
};

/** Stored details are re-read from the source at most this often… */
const DETAILS_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** …or daily while they are still placeholders ("Unknown" author, no description), which is
 * what a title keeps when the source could not describe it at the time it was added. */
const INCOMPLETE_DETAILS_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Library titles keep the author, description, genres and status they had when they were
 * added; without this a series that finished stays "Ongoing" forever, and a source fix that
 * starts reading authors never reaches titles already in a library. Returns the fresh
 * cover URL, or '' when nothing was due.
 */
const refreshStoredDetails = async (
  source_id: string,
  manga_slug: string,
  library_id: string,
  now = Date.now(),
): Promise<string> => {
  const stored = await mangaRepository.getDetailsUpdatedAt(library_id);
  const age = stored ? now - stored.updatedAt.getTime() : Infinity;
  const due = stored?.incomplete ? INCOMPLETE_DETAILS_REFRESH_MS : DETAILS_REFRESH_MS;
  if (age < due) return '';
  const details = await getMangaDetails(source_id, manga_slug);
  await mangaRepository.refreshDetails(library_id, {
    author: details.author?.join(', ') || 'Unknown',
    artist: details.artist?.join(', ') || 'Unknown',
    description: details.description ?? '',
    genres: (details.genres ?? []).join(', '),
    status: details.status,
    thumbnail_url: details.thumbnail_url || undefined,
  });
  return details.thumbnail_url || '';
};

/**
 * Pulls the source's current chapter list, diffs it against what's already stored, and
 * persists anything new. Extensions only report data — persistence lives here so sources
 * stay isolated from the database. This is a background/best-effort check, so unlike the
 * methods above, a source failure here is logged and degrades to "no updates found"
 * rather than failing the request.
 */
const fetchMangaUpdates = async (
  source_id: string,
  manga_slug: string,
  manga_id?: string,
): Promise<{
  newChapters: number;
  /** The new chapters, so a client can queue them for download. */
  newChapterList: AddedChapter[];
  changedChapters: number;
  thumbnail_url: string;
  failed: boolean;
}> => {
  const source = await getSourceById(source_id);
  // Resolves the library row (if any) so log entries can carry a real manga_id/title
  // even when the caller only supplied the slug.
  const libraryManga = manga_id
    ? await mangaRepository.getMangaById(manga_id)
    : await mangaRepository.getMangaBySlug(manga_slug, source_id);
  const resolvedMangaId = libraryManga?.id ?? manga_id;
  const mangaTitle = libraryManga?.title ?? manga_slug;

  recordSourceAttempt(source_id, 'update');
  let newChapters = 0;
  let newChapterList: AddedChapter[] = [];
  let changedChapters = 0;
  let failed = false;
  let updateErrorCode: SourceErrorCode | 'UNCLASSIFIED' = 'UNCLASSIFIED';
  let updateRetryAfterMs: number | undefined;
  try {
    const rawChapters = await source.fetchMangaUpdates(manga_slug);

    // Validated harder than the read-only paths above, because this is the one place a
    // source's output is *written to the database* rather than passed through to a
    // response. A malformed chapter here becomes a stored row that every later read has to
    // cope with.
    const latestChapters = parseSourceOutput(
      sourceChapterListSchema,
      rawChapters,
      source_id,
      'fetchMangaUpdates',
    );

    // Not a plain "insert unseen ids": a chapter whose link changed on the site comes back
    // under a new id, and is relinked (state carried over) rather than counted as new. The
    // source is also the authority on its own numbering and metadata for known ids.
    const sync = await chapterService.syncChapters(manga_slug, latestChapters, source_id);
    newChapters = sync.added;
    newChapterList = sync.addedChapters;
    if (newChapters > 0) announceLibraryChange(EVERYONE, 'library');
    changedChapters = sync.relinked + sync.updated + sync.removed;

    if (newChapters > 0 && resolvedMangaId) {
      await updateLogService.logNewChapters(source_id, resolvedMangaId, mangaTitle, newChapters);
      await libraryService.resetNotification(resolvedMangaId);
    }
  } catch (error) {
    failed = true;
    const healthFailure = sourceHealthFailure(error);
    updateErrorCode = healthFailure.code;
    updateRetryAfterMs = healthFailure.retryAfterMs;
    const message = isSourceErrorLike(error) ? error.message : error;
    console.warn(`Failed to fetch chapter updates for ${source_id}/${manga_slug}:`, message);
    await updateLogService.logError(source_id, resolvedMangaId, mangaTitle, error);
  }

  let thumbnail_url = '';
  if (!failed && libraryManga) {
    try {
      thumbnail_url = await refreshStoredDetails(source_id, manga_slug, libraryManga.id);
    } catch (error) {
      console.warn(`Failed to refresh details for ${source_id}/${manga_slug}:`, error);
    }
  }
  if (!thumbnail_url && manga_id) {
    try {
      // The source's own id for the title, not the library row id.
      thumbnail_url = await getMangaThumbnail(source_id, manga_slug);
    } catch (error) {
      console.warn(`Failed to fetch thumbnail for ${source_id}/${manga_slug}:`, error);
    }
  }

  recordSourceOperation(
    source_id,
    'update',
    failed
      ? { success: false, code: updateErrorCode, retryAfterMs: updateRetryAfterMs }
      : { success: true },
  );

  return {
    newChapters,
    newChapterList,
    changedChapters,
    thumbnail_url,
    failed,
  };
};

export interface LibraryUpdateResult {
  checked: number;
  mangaWithNewChapters: number;
  totalNewChapters: number;
  /** Titles that couldn't be checked, such as ones whose source was uninstalled. */
  failed: number;
  /** True when this call joined a sweep that was already running instead of starting
   * a second one. The counts then describe that shared sweep. */
  alreadyRunning: boolean;
}

/**
 * Only one sweep runs at a time, process-wide.
 *
 * The endpoint behind this is reachable without an account (the app works fully
 * anonymously, so it can't be put behind requireAuth), and each sweep scrapes an
 * upstream source per title. Concurrent full-catalog sweeps would get this app's IP
 * blocked by sources. Callers join the running sweep rather than starting another.
 *
 * In-memory and single-process, like the OAuth state map in tracker.service.ts: a
 * restart mid-sweep just means the next call starts a fresh one.
 */
let inFlightSweep: Promise<LibraryUpdateResult> | null = null;

/**
 * Runs `fetchMangaUpdates` for every manga actually in a library — backs the
 * "Update Library" button. Sequential, not parallel: sources are scraped over the
 * network and shouldn't all be hit at once.
 */
const runLibraryUpdateSweep = async (): Promise<LibraryUpdateResult> => {
  const mangaList = await mangaRepository.listLibraryBasic();
  let mangaWithNewChapters = 0;
  let totalNewChapters = 0;
  let failed = 0;

  for (const m of mangaList) {
    // One title can't stop the rest: fetchMangaUpdates throws for a source that's no longer
    // installed, and nobody is waiting on this request to hear about it.
    try {
      const result = await fetchMangaUpdates(m.source, m.slug, m.id);
      if (result.failed) failed += 1;
      if (result.newChapters > 0) {
        mangaWithNewChapters += 1;
        totalNewChapters += result.newChapters;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    checked: mangaList.length,
    mangaWithNewChapters,
    totalNewChapters,
    failed,
    alreadyRunning: false,
  };
};

const urlKeysResultSchema = z.object({
  supported: z.boolean(),
  manga: z.array(z.string().min(1).max(512).nullable()),
  chapters: z.array(z.string().min(1).max(512).nullable()),
});

/**
 * Turns Mihon/Tachiyomi URLs into this app's title slugs and chapter keys through the
 * source's own `keyFromUrl`, for a backup import. No network: the source only parses the
 * URLs. A source without `keyFromUrl` answers `supported: false`, and the importer then
 * falls back to matching read state by chapter number.
 */
const keysFromUrls = async (sourceId: string, body: SourceUrlKeysBody): Promise<UrlKeysResult> => {
  const source = (await getSourceById(sourceId)) as Partial<SandboxedSource>;
  const unsupported = {
    supported: false,
    manga: body.manga.map(() => null),
    chapters: body.chapters.map(() => null),
  };
  if (typeof source.keysFromUrls !== 'function') return unsupported;
  try {
    const result = urlKeysResultSchema.parse(await source.keysFromUrls(body));
    // A result that does not line up with the request cannot be trusted at all.
    if (
      result.manga.length !== body.manga.length ||
      result.chapters.length !== body.chapters.length
    )
      return unsupported;
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) return unsupported;
    translateSourceError(error);
  }
};

/** The last sweep that finished, for anyone who started one and came back to look. */
let lastSweep: (LibraryUpdateResult & { finished_at: string }) | null = null;

const checkAllLibraryUpdates = async (): Promise<LibraryUpdateResult> => {
  if (inFlightSweep) {
    const result = await inFlightSweep;
    return { ...result, alreadyRunning: true };
  }

  inFlightSweep = runLibraryUpdateSweep();
  try {
    const result = await inFlightSweep;
    lastSweep = { ...result, finished_at: new Date().toISOString() };
    return result;
  } finally {
    inFlightSweep = null;
  }
};

/**
 * Starts a sweep and returns straight away: it scrapes every title in turn, so it can
 * outlast any request. `getLibrarySweepStatus` reports on it, and open apps hear about it
 * through the library event stream when it finishes.
 */
const startLibrarySweep = (): { started: boolean } => {
  if (inFlightSweep) return { started: false };
  void checkAllLibraryUpdates()
    .then(() => announceLibraryChange(EVERYONE, 'library'))
    .catch((error) => console.error('[source.service] Library update sweep failed:', error));
  return { started: true };
};

const getLibrarySweepStatus = () => ({ running: inFlightSweep !== null, last: lastSweep });

const sourceService = {
  getCapabilities,
  getAllCapabilities,
  getCataloguePage,
  getSources,
  getManga,
  searchManga,
  getMangaDetails,
  getMangaThumbnail,
  getChapterPages,
  getFilters,
  fetchMangaUpdates,
  keysFromUrls,
  checkAllLibraryUpdates,
  startLibrarySweep,
  getLibrarySweepStatus,
};

export default sourceService;
