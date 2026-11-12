import type {
  Mangas,
  MangaDetails,
  MangaFilter,
  Pagination,
  FilterValue,
  Page,
  Chapters,
  ChapterPagesResult,
  Source,
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
import { resolveSource } from './sourceResolver.service.js';
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
 * Every call into a source, with the policy a call owes built in: the source is looked up
 * fresh, the attempt and its outcome go to source health, what comes back is checked
 * before any of it is used, and a source's own error becomes one this API can answer with.
 *
 * This is the only module that holds a raw source (tests/sourceCallPolicy.test.ts keeps it
 * that way), so a caller cannot skip a step: browsing, the reader and the download worker
 * all get the same checked result.
 */

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

export function isSourceErrorLike(error: unknown): error is SourceErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

export function sourceHealthFailure(error: unknown): {
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

/** What a caller may know about a source without calling it. */
export interface SourceInfo {
  id: string;
  base_url: string;
}

const installedSource = async (sourceId: string): Promise<Source> => {
  const source = await resolveSource(sourceId);
  if (!source) {
    throw new ServiceUnavailableError(`Source not found: ${sourceId}`);
  }
  return source;
};

/** The source's own facts, or a refusal when it is not installed (any more). */
const requireSource = async (sourceId: string): Promise<SourceInfo> => {
  const source = await installedSource(sourceId);
  return { id: sourceId, base_url: source.base_url };
};

/** Whether the source is installed, without calling it. */
const isInstalled = async (sourceId: string): Promise<boolean> =>
  Boolean(await resolveSource(sourceId));

type Parse = <S extends z.ZodTypeAny>(schema: S, value: unknown, method: string) => z.infer<S>;

/**
 * One call into a source. `run` is handed the source and a `parse` bound to it, and
 * returns only what `parse` gave back. `operation` is the health record the call counts
 * towards; null for calls that say nothing about whether the site is reachable.
 */
async function call<T>(
  sourceId: string,
  operation: 'browse' | null,
  run: (source: Source, parse: Parse) => Promise<T>,
): Promise<T> {
  const source = await installedSource(sourceId);
  if (operation) recordSourceAttempt(sourceId, operation);
  try {
    const result = await run(source, (schema, value, method) =>
      parseSourceOutput(schema, value, sourceId, method),
    );
    if (operation) recordSourceOperation(sourceId, operation, { success: true });
    return result;
  } catch (error) {
    if (operation) recordSourceOperation(sourceId, operation, sourceHealthFailure(error));
    translateSourceError(error);
  }
}

const getManga = (params: {
  sourceId: string;
  category: string;
  pagination: Pagination;
  filters?: Record<string, FilterValue>;
}): Promise<Mangas[]> =>
  call(params.sourceId, 'browse', async (source, parse) =>
    parse(
      sourceMangaListSchema,
      await source.fetchManga(params.category, params.pagination, params.filters || {}),
      'fetchManga',
    ),
  );

const searchManga = (params: {
  sourceId: string;
  query: string;
  pagination: Pagination;
  filters?: Record<string, FilterValue>;
}): Promise<Mangas[]> =>
  call(params.sourceId, 'browse', async (source, parse) =>
    parse(
      sourceMangaListSchema,
      await source.searchManga(params.query, params.pagination, params.filters || {}),
      'searchManga',
    ),
  );

const getCapabilities = (sourceId: string): Promise<SourceCapabilities> =>
  call(sourceId, null, async (source, parse) => {
    if (!source.getCapabilities) throw new UpstreamError('Source catalogue runtime is unavailable');
    return parse(sourceCapabilitiesSchema, await source.getCapabilities(), 'getCapabilities');
  });

const getCataloguePage = (
  params: {
    sourceId: string;
    category?: string;
    query?: string;
    pagination: SourcePageRequest;
    filters?: Record<string, FilterValue>;
  },
  search = false,
): Promise<SourceCataloguePage> =>
  call(params.sourceId, 'browse', async (source, parse) => {
    const method = search ? source.searchMangaPage : source.fetchMangaPage;
    if (!method) throw new UpstreamError('Source catalogue runtime is unavailable');
    const result = await method.call(
      source,
      search ? params.query : params.category,
      params.pagination,
      params.filters || {},
    );
    const parsed = parse(
      sourceCataloguePageSchema,
      result,
      search ? 'searchMangaPage' : 'fetchMangaPage',
    );
    if (parsed.hasMore && parsed.nextCursor === params.pagination.cursor) {
      throw new UpstreamError('Source returned a catalogue cursor that did not advance');
    }
    return parsed;
  });

const getMangaDetails = (source_id: string, manga_id: string): Promise<MangaDetails> =>
  call(source_id, 'browse', async (source, parse) =>
    parse(sourceMangaDetailsSchema, await source.fetchMangaDetails(manga_id), 'fetchMangaDetails'),
  );

const getMangaThumbnail = (source_id: string, manga_id: string): Promise<string> =>
  call(source_id, 'browse', async (source, parse) => {
    if (typeof source.fetchMangaThumbnail === 'function') {
      const url: unknown = await source.fetchMangaThumbnail(manga_id);
      // Narrower than the schemas above because the return value is a bare string; anything
      // else would end up rendered as an image src.
      return typeof url === 'string' ? url : '';
    }
    const details = parse(
      sourceMangaDetailsSchema,
      await source.fetchMangaDetails(manga_id),
      'fetchMangaDetails',
    );
    return details.thumbnail_url || '';
  });

const getChapterPages = (
  source_id: string,
  chapter_id: string,
  manga_slug?: string,
  pagination?: Pagination,
): Promise<ChapterPagesResult<Page>> =>
  call(source_id, 'browse', async (source, parse) =>
    parse(
      sourceChapterPagesSchema,
      await source.fetchChapterPages(chapter_id, manga_slug, pagination),
      'fetchChapterPages',
    ),
  );

const getFilters = (source_id: string): Promise<MangaFilter[]> =>
  call(source_id, 'browse', async (source, parse) =>
    parse(sourceMangaFilterListSchema, await source.getFilters(), 'getFilters'),
  );

/**
 * The source's current chapter list for a title, checked but otherwise as the source
 * left it: nothing goes to source health and the source's own error is thrown unchanged.
 * For the update check alone, which records one outcome for the whole check (the list
 * and storing it) and logs the source's error by its own code.
 */
const readChapterList = async (source_id: string, manga_slug: string): Promise<Chapters[]> => {
  const source = await installedSource(source_id);
  return parseSourceOutput(
    sourceChapterListSchema,
    await source.fetchMangaUpdates(manga_slug),
    source_id,
    'fetchMangaUpdates',
  );
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
  const source = (await installedSource(sourceId)) as Partial<SandboxedSource>;
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

const verifiedSource = {
  isInstalled,
  requireSource,
  getCapabilities,
  getCataloguePage,
  getManga,
  searchManga,
  getMangaDetails,
  getMangaThumbnail,
  getChapterPages,
  getFilters,
  readChapterList,
  keysFromUrls,
};

export default verifiedSource;
