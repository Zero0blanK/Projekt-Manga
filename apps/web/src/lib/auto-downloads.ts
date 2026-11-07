import {
  cancelDownload,
  initiateDownload,
  type DownloadSummary,
  type MangaChapterRecord,
} from '@projekt-manga/api-client';
import { getAppState, getSetting } from '@/lib/app-store';
import { fetchDownloads } from '@/lib/shared-queries';

/**
 * Settings keys for automatic downloads (Settings → Sync & Storage → Downloads).
 *
 * `autoDownloadNew`: 'off', 'all', or `category:<name>` — which titles get the chapters a
 * library update finds downloaded. Stored as one string because settings are primitives.
 */
export const AUTO_DOWNLOAD_NEW = 'autoDownloadNew';
/** 'off' | 'immediately' | 'afterNext': drop a chapter's download once it is read, or once
 * the chapter after it is read (so going back one chapter still works offline). */
export const DELETE_AFTER_READ = 'deleteAfterRead';
/** How many chapters past the one being read to keep downloaded, 0–5. */
export const DOWNLOAD_AHEAD = 'downloadAhead';

const CATEGORY_PREFIX = 'category:';

export type DeleteAfterReadMode = 'off' | 'immediately' | 'afterNext';

/** A chapter as these helpers need it. */
type ChapterRef = Pick<MangaChapterRecord, 'id' | 'source_chapter_key' | 'chapter_number'> &
  Partial<Pick<MangaChapterRecord, 'name' | 'is_bookmark'>>;

/** Whether a library update's new chapters for `mangaId` should be downloaded. */
export function autoDownloadApplies(
  scope: string,
  mangaId: string,
  categoryMembers: Record<string, string[]>,
): boolean {
  if (scope === 'all') return true;
  if (!scope.startsWith(CATEGORY_PREFIX)) return false;
  return (categoryMembers[scope.slice(CATEGORY_PREFIX.length)] ?? []).includes(mangaId);
}

export const categoryScope = (name: string) => `${CATEGORY_PREFIX}${name}`;

/**
 * The chapters to download ahead of `current`: the next `count` distinct chapter numbers,
 * one release each (`pick` chooses it, as the reader does), skipping ones already
 * downloaded or queued.
 */
export function downloadAheadTargets<T extends ChapterRef>(
  sortedNumbers: number[],
  pick: (chapterNumber: number) => T | undefined,
  current: number,
  count: number,
  alreadyHave: ReadonlySet<string>,
): T[] {
  if (count <= 0) return [];
  const targets: T[] = [];
  for (const number of sortedNumbers) {
    if (number <= current) continue;
    if (targets.length >= count) break;
    const record = pick(number);
    if (record && !alreadyHave.has(record.source_chapter_key)) targets.push(record);
  }
  return targets;
}

/**
 * The chapter whose download goes once `justRead` is read: that chapter itself, or the
 * one before it with 'afterNext'. Bookmarked chapters are kept — a bookmark is a reason
 * to come back.
 */
export function deleteAfterReadTarget<T extends ChapterRef>(
  mode: DeleteAfterReadMode,
  justRead: number,
  sortedNumbers: number[],
  pick: (chapterNumber: number) => T | undefined,
): T | null {
  if (mode === 'off') return null;
  let target = justRead;
  if (mode === 'afterNext') {
    const previous = sortedNumbers.filter((number) => number < justRead).at(-1);
    if (previous === undefined) return null;
    target = previous;
  }
  const record = pick(target);
  return record && !record.is_bookmark ? record : null;
}

type TitleRef = { source: string; slug: string; title: string };

/** Queues downloads for chapters of one title. Failures (storage limit, a full queue) are
 * counted, not thrown: an automatic download must never break the action that caused it. */
export async function queueChapterDownloads(
  manga: TitleRef,
  chapters: Array<{ source_chapter_key: string; chapter_number: number; name?: string | null }>,
): Promise<{ queued: number; failed: number }> {
  let queued = 0;
  let failed = 0;
  for (const chapter of chapters) {
    try {
      await initiateDownload({
        sourceId: manga.source,
        mangaSlug: manga.slug,
        mangaTitle: manga.title,
        chapter: {
          id: chapter.source_chapter_key,
          name: chapter.name ?? undefined,
          chapter_number: chapter.chapter_number,
        },
      });
      queued++;
    } catch {
      failed++;
    }
  }
  return { queued, failed };
}

/** Source keys of this title's chapters that are downloaded or on their way. */
export function activeDownloadKeys(downloads: DownloadSummary[], source: string, slug: string) {
  return new Set(
    downloads
      .filter((d) => d.source_id === source && d.mangaSlug === slug && d.status !== 'FAILED')
      .map((d) => d.source_chapter_key),
  );
}

/** Queues new chapters a library update found, when the setting covers this title. */
export async function autoDownloadNewChapters(
  manga: TitleRef & { id: string },
  chapters: Array<{ source_chapter_key: string; chapter_number: number; name: string | null }>,
) {
  if (chapters.length === 0) return;
  const scope = getSetting(AUTO_DOWNLOAD_NEW, 'off') as string;
  if (!autoDownloadApplies(scope, manga.id, getAppState().categoryMembers)) return;
  await queueChapterDownloads(manga, chapters);
}

/** After a chapter is read: download ahead and drop the download the setting says to. */
export async function afterChapterRead<T extends ChapterRef>(
  manga: TitleRef,
  justRead: number,
  sortedNumbers: number[],
  pick: (chapterNumber: number) => T | undefined,
) {
  const mode = getSetting(DELETE_AFTER_READ, 'off') as DeleteAfterReadMode;
  const target = deleteAfterReadTarget(mode, justRead, sortedNumbers, pick);
  if (!target) return;
  const download = (await fetchDownloads()).find(
    (d) =>
      d.source_id === manga.source &&
      d.mangaSlug === manga.slug &&
      d.source_chapter_key === target.source_chapter_key &&
      d.status === 'COMPLETED',
  );
  if (download) await cancelDownload(download.id);
}

/** When a chapter opens: keep the next `downloadAhead` chapters downloaded. */
export async function downloadAhead<T extends ChapterRef>(
  manga: TitleRef,
  current: number,
  sortedNumbers: number[],
  pick: (chapterNumber: number) => T | undefined,
) {
  const count = Number(getSetting(DOWNLOAD_AHEAD, 0)) || 0;
  if (count <= 0) return;
  const have = activeDownloadKeys(await fetchDownloads(), manga.source, manga.slug);
  await queueChapterDownloads(
    manga,
    downloadAheadTargets(sortedNumbers, pick, current, count, have),
  );
}
