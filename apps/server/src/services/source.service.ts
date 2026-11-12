import type { SourceCapabilities, SourceErrorCode } from '@projekt-manga/types';
import { getInstalledSandboxedSources } from './sandboxedSourceRegistry.service.js';
import verifiedSource, {
  isSourceErrorLike,
  sourceHealthFailure,
} from './verifiedSource.service.js';
import { announceLibraryChange, EVERYONE } from '../utils/libraryChanges.js';
import { getSuwayomiSourceSummaries } from './suwayomi/registry.js';
import chapterService from './chapter.service.js';
import type { AddedChapter } from '../repositories/chapter.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import libraryService from './library.service.js';
import updateLogService from './updateLog.service.js';
import { recordSourceAttempt, recordSourceOperation } from './sourceHealth.service.js';

// Calls into a source live in verifiedSource.service.ts, which checks what comes back and
// keeps source health. This file is what the app does with the answers: the source list,
// the update check and the library sweep.
const { getMangaDetails, getMangaThumbnail } = verifiedSource;

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

/** Every listed source's capabilities in one call; a source that fails is left out, and
 * asking for it alone reports why. */
const getAllCapabilities = async (): Promise<Record<string, SourceCapabilities>> => {
  const sources = await getSources();
  const results = await Promise.allSettled(
    sources.map(
      async (source) => [source.id, await verifiedSource.getCapabilities(source.id)] as const,
    ),
  );
  return Object.fromEntries(
    results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
  );
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
  await verifiedSource.requireSource(source_id);
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
    // Checked harder than a read-only call would need, because this is the one place a
    // source's output is *written to the database* rather than passed through to a
    // response. A malformed chapter here becomes a stored row that every later read has to
    // cope with.
    const latestChapters = await verifiedSource.readChapterList(source_id, manga_slug);

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
    console.warn('Failed to fetch chapter updates for %s/%s:', source_id, manga_slug, message);
    await updateLogService.logError(source_id, resolvedMangaId, mangaTitle, error);
  }

  let thumbnail_url = '';
  if (!failed && libraryManga) {
    try {
      thumbnail_url = await refreshStoredDetails(source_id, manga_slug, libraryManga.id);
    } catch (error) {
      console.warn('Failed to refresh details for %s/%s:', source_id, manga_slug, error);
    }
  }
  if (!thumbnail_url && manga_id) {
    try {
      // The source's own id for the title, not the library row id.
      thumbnail_url = await getMangaThumbnail(source_id, manga_slug);
    } catch (error) {
      console.warn('Failed to fetch thumbnail for %s/%s:', source_id, manga_slug, error);
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
  getCapabilities: verifiedSource.getCapabilities,
  getAllCapabilities,
  getCataloguePage: verifiedSource.getCataloguePage,
  getSources,
  getManga: verifiedSource.getManga,
  searchManga: verifiedSource.searchManga,
  getMangaDetails,
  getMangaThumbnail,
  getChapterPages: verifiedSource.getChapterPages,
  getFilters: verifiedSource.getFilters,
  fetchMangaUpdates,
  keysFromUrls: verifiedSource.keysFromUrls,
  checkAllLibraryUpdates,
  startLibrarySweep,
  getLibrarySweepStatus,
};

export default sourceService;
