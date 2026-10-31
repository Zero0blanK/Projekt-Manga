import type { TrackerName } from '@projekt-manga/api-client';
import type { PreviewBackupBody } from '@projekt-manga/schemas';
import type { MihonBackup, MihonChapter, MihonManga } from './decode';
import { mapStatus, mapTracking } from './mapping';
import type { FoundTitle } from './search';

/** What `keyFromUrl` made of one Mihon source's URLs (see `resolveMihonKeys`). */
export interface SourceKeys {
  /** False when the source has no `keyFromUrl`: chapter state is then matched by number. */
  supported: boolean;
  manga: Map<string, string | null>;
  chapters: Map<string, string | null>;
}

export interface MihonImportOptions {
  /** Mihon source id → installed source id, or null when it has none. */
  sources: ReadonlyMap<string, string | null>;
  keys: ReadonlyMap<string, SourceKeys>;
  /** Titles from sources with no installed match: left out, or added to the library
   * without chapters so `/manga/[id]/migrate` can move them later. */
  unmatched: 'skip' | 'import';
  /** Backup manga index → the installed source a title search found it in (see
   * `findTitlesInSources`), for titles whose own source has no match. */
  found?: ReadonlyMap<number, FoundTitle>;
}

/** Read state for a title whose source cannot name its chapters from Mihon's URLs. It is
 * applied by chapter number once the title's chapter list has been synced. */
export interface ChapterNumberState {
  source: string;
  slug: string;
  read: number[];
  /** Chapter number → last page read, for unfinished chapters. */
  lastPage: Array<[number, number]>;
}

export interface MihonImportExtras {
  categories: Array<{ name: string; titles: Array<{ source: string; slug: string }> }>;
  trackers: Array<{ source: string; slug: string; tracker: TrackerName; tracker_media_id: string }>;
  chapterNumbers: ChapterNumberState[];
}

export interface MihonImportStats {
  libraryTitles: number;
  matchedTitles: number;
  /** Titles with no matched source that a title search found in another source. */
  foundBySearch: number;
  unmatchedImported: number;
  unmatchedSkipped: number;
  /** Titles whose slug was guessed from the URL because the source has no `keyFromUrl`. */
  guessedSlugs: number;
  chaptersWithState: number;
  chaptersByNumber: number;
  history: number;
  categories: number;
  trackerLinks: number;
  /** Tracker rows for a tracker this app does not support. */
  skippedTrackers: number;
}

export type MihonRestorePayload = Omit<PreviewBackupBody, 'mode' | 'expectedUserId'>;

export interface MihonImport {
  payload: MihonRestorePayload;
  extras: MihonImportExtras;
  stats: MihonImportStats;
}

type RestoreManga = MihonRestorePayload['manga'][number];
type RestoreChapter = RestoreManga['chapters'][number];
type RestoreHistory = MihonRestorePayload['history'][number];

/** Matches the restore schema's caps, so an oversized backup fails here with a reason. */
const MAX_TITLES = 10_000;
const MAX_CHAPTERS = 50_000;
const MAX_HISTORY = 50_000;
/** Shown for titles with no cover; not an http(s) URL, so it is never fetched. */
const NO_COVER = 'none';

const iso = (ms: number) => {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** For sources without `keyFromUrl`: most sources' title URLs end in their id or slug. */
export function guessSlug(url: string): string | null {
  const path = url.split(/[?#]/)[0];
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last.length <= 512 ? decodeURIComponentSafe(last) : null;
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const hasState = (chapter: MihonChapter) =>
  chapter.read || chapter.bookmark || chapter.lastPageRead > 0;

/** A Mihon source's name from the backup, or its id when the backup has none. */
export function unmatchedSourceName(backup: MihonBackup, id: string) {
  return backup.sources.find((source) => source.id === id)?.name || id;
}

/**
 * Builds the version-2 restore payload, plus what it cannot carry (categories, tracker
 * links, read state by chapter number), from a decoded Mihon backup.
 *
 * Only chapters with some state (read, bookmarked, partly read) are sent: the rest come
 * from the source on the title's next chapter sync, so leaving them out keeps big
 * libraries within the restore's size limits.
 */
export function buildMihonImport(backup: MihonBackup, options: MihonImportOptions): MihonImport {
  const stats: MihonImportStats = {
    libraryTitles: 0,
    matchedTitles: 0,
    foundBySearch: 0,
    unmatchedImported: 0,
    unmatchedSkipped: 0,
    guessedSlugs: 0,
    chaptersWithState: 0,
    chaptersByNumber: 0,
    history: 0,
    categories: 0,
    trackerLinks: 0,
    skippedTrackers: 0,
  };
  const categoryNames = new Map(backup.categories.map((category) => [category.order, category]));
  const manga = new Map<string, RestoreManga>();
  const history = new Map<string, RestoreHistory>();
  const categories = new Map<string, Array<{ source: string; slug: string }>>();
  const trackers = new Map<string, MihonImportExtras['trackers'][number]>();
  const byNumber = new Map<string, ChapterNumberState>();

  const addTitleExtras = (title: MihonManga, source: string, slug: string) => {
    for (const order of new Set(title.categories)) {
      const name = categoryNames.get(order)?.name.trim();
      if (!name) continue;
      const members = categories.get(name) ?? [];
      if (!members.some((m) => m.source === source && m.slug === slug))
        members.push({ source, slug });
      categories.set(name, members);
    }
    for (const row of title.tracking) {
      const link = mapTracking(row);
      if (!link) {
        stats.skippedTrackers += 1;
        continue;
      }
      trackers.set(`${source}\0${slug}\0${link.tracker}`, { source, slug, ...link });
    }
  };

  const baseEntry = (title: MihonManga, id: string, source: string, slug: string) => ({
    id,
    source,
    slug,
    title: (title.title.trim() || slug).slice(0, 255),
    author: (title.author?.trim() || 'Unknown').slice(0, 255),
    artist: title.artist?.trim() || null,
    thumbnail_url: title.thumbnailUrl?.trim() || NO_COVER,
    description: title.description ?? '',
    genres: title.genres
      .map((genre) => genre.trim())
      .filter(Boolean)
      .join(', '),
    status: mapStatus(title.status),
    rating: null,
  });

  for (const [index, title] of backup.manga.entries()) {
    const found = options.sources.get(title.source) ? undefined : options.found?.get(index);
    const sourceId = options.sources.get(title.source) ?? found?.sourceId ?? null;
    if (!sourceId) {
      if (!title.favorite) continue;
      if (options.unmatched === 'skip' || !title.url) {
        stats.unmatchedSkipped += 1;
        continue;
      }
      // Kept under a source of its own: nothing can sync it, but migrate can move it.
      const source = `mihon:${unmatchedSourceName(backup, title.source)}`;
      const slug = title.url.slice(0, 512);
      if (manga.has(`${source}\0${slug}`)) continue;
      manga.set(`${source}\0${slug}`, {
        ...baseEntry(title, `mihon-${index}`, source, slug),
        chapters: [],
      });
      addTitleExtras(title, source, slug);
      stats.unmatchedImported += 1;
      continue;
    }

    // A title found by search is on another site: Mihon's URLs mean nothing there, so its
    // chapter state goes by number.
    const keys = found ? undefined : options.keys.get(title.source);
    let slug = found?.slug ?? keys?.manga.get(title.url) ?? null;
    if (!slug) {
      slug = guessSlug(title.url);
      if (!slug) {
        if (title.favorite) stats.unmatchedSkipped += 1;
        continue;
      }
      if (title.favorite) stats.guessedSlugs += 1;
    }
    const titleKey = `${sourceId}\0${slug}`;
    const chapterKey = (url: string) => (keys?.supported ? (keys.chapters.get(url) ?? null) : null);
    const chaptersByUrl = new Map(title.chapters.map((chapter) => [chapter.url, chapter]));

    if (title.favorite) {
      let entry = manga.get(titleKey);
      if (!entry) {
        entry = { ...baseEntry(title, `mihon-${index}`, sourceId, slug), chapters: [] };
        // The old site's cover may not load from here; the new source's will.
        if (found?.thumbnailUrl) entry.thumbnail_url = found.thumbnailUrl;
        manga.set(titleKey, entry);
        stats.matchedTitles += 1;
        if (found) stats.foundBySearch += 1;
      }
      const keyed = new Map<string, RestoreChapter>(
        entry.chapters.map((chapter) => [chapter.id, chapter]),
      );
      const numbered = byNumber.get(titleKey) ?? { source: sourceId, slug, read: [], lastPage: [] };
      for (const chapter of title.chapters) {
        if (!hasState(chapter)) continue;
        const key = chapterKey(chapter.url);
        if (!key) {
          // Mihon uses -1 for "no number"; such a chapter cannot be matched later.
          if (chapter.chapterNumber < 0) continue;
          if (chapter.read) numbered.read.push(chapter.chapterNumber);
          else if (chapter.lastPageRead > 0)
            numbered.lastPage.push([chapter.chapterNumber, chapter.lastPageRead]);
          else continue;
          stats.chaptersByNumber += 1;
          continue;
        }
        const previous = keyed.get(key);
        keyed.set(key, {
          source_chapter_key: key,
          id: key,
          url: chapter.url,
          name: chapter.name || null,
          scanlator: chapter.scanlator,
          chapter_number: Number.isFinite(chapter.chapterNumber) ? chapter.chapterNumber : 0,
          last_page_read: Math.max(chapter.lastPageRead, previous?.last_page_read ?? 0),
          is_read: chapter.read || (previous?.is_read ?? false),
          is_bookmark: chapter.bookmark || (previous?.is_bookmark ?? false),
          release_date: iso(chapter.dateUpload),
          page_count: null,
        });
      }
      entry.chapters = [...keyed.values()];
      if (numbered.read.length > 0 || numbered.lastPage.length > 0)
        byNumber.set(titleKey, numbered);
      addTitleExtras(title, sourceId, slug);
    }

    const entryId = manga.get(titleKey)?.id ?? null;
    for (const row of title.history) {
      const readAt = iso(row.lastRead);
      if (!readAt) continue;
      const chapter = chaptersByUrl.get(row.url);
      const key = chapterKey(row.url);
      // Unkeyed rows would all share one history slot per title; keep the latest.
      const historyKey = `${titleKey}\0${key ?? ''}`;
      const previous = history.get(historyKey);
      if (previous && previous.last_read >= readAt) continue;
      history.set(historyKey, {
        source: sourceId,
        manga_slug: slug,
        manga_id: entryId,
        source_chapter_key: key,
        title: (title.title.trim() || slug).slice(0, 255),
        ...(found?.thumbnailUrl || title.thumbnailUrl
          ? { thumbnail_url: found?.thumbnailUrl || title.thumbnailUrl }
          : {}),
        read_at: readAt,
        last_read: readAt,
        last_page_read: chapter?.lastPageRead ?? 0,
        is_read: chapter?.read ?? false,
        chapter_number: chapter && chapter.chapterNumber >= 0 ? chapter.chapterNumber : null,
        page_count: null,
        pages_read: 1,
      });
    }
  }

  const mangaList = [...manga.values()];
  stats.libraryTitles = mangaList.length;
  stats.chaptersWithState = mangaList.reduce((total, entry) => total + entry.chapters.length, 0);
  if (mangaList.length > MAX_TITLES)
    throw new Error(
      `This backup has ${mangaList.length} titles; at most ${MAX_TITLES} can be imported.`,
    );
  if (stats.chaptersWithState > MAX_CHAPTERS)
    throw new Error(
      `This backup has ${stats.chaptersWithState} chapters with reading state; at most ${MAX_CHAPTERS} can be imported.`,
    );
  // The oldest history is the least useful; drop it rather than refuse the import.
  const historyList = [...history.values()]
    .sort((a, b) => b.last_read.localeCompare(a.last_read))
    .slice(0, MAX_HISTORY);
  stats.history = historyList.length;
  stats.categories = categories.size;
  stats.trackerLinks = trackers.size;

  return {
    payload: { version: 2, manga: mangaList, library: [], history: historyList },
    extras: {
      categories: [...categories.entries()].map(([name, titles]) => ({ name, titles })),
      trackers: [...trackers.values()],
      chapterNumbers: [...byNumber.values()],
    },
    stats,
  };
}
