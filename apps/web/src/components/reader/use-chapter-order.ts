'use client';

import { useMemo } from 'react';
import type { MangaChapterRecord } from '@projekt-manga/api-client';
import { useDownloads } from '@/lib/shared-queries';
import { useProfilePreference } from '@/lib/profile-preferences';
import { useSetting } from '@/lib/app-store';
import { useChapterBookmarks } from '@/lib/chapter-bookmarks';
import {
  SKIP_DUPLICATE_CHAPTERS,
  SKIP_READ_CHAPTERS,
  adjacentChapter,
  adjacentRelease,
  releaseStops,
} from '@/lib/chapter-skip';
import {
  DEFAULT_CHAPTER_FILTER,
  SKIP_FILTERED_CHAPTERS,
  chapterFilterKey,
  isFilterActive,
  parseChapterFilter,
  releasePassesFilter,
} from '@/lib/chapter-filter';

/**
 * The order a title's chapters are read in: which release stands for the chapter being
 * read, and what comes next and before it.
 *
 * A title's list is not a simple sequence. Numbers are not contiguous (10.3, 11.1, 11.2),
 * one number can have a release from each translation group, and the reader's settings
 * decide what is passed over: read chapters, ones the chapter-list filter hides, and
 * (unless turned off) every release of a number but one. The reader asks this for
 * "next" and "previous" and never works them out itself.
 */
export function useChapterOrder({
  mangaId,
  chapters,
  chapter,
  preferredGroup,
  requestedChapterId,
}: {
  mangaId: string;
  chapters: MangaChapterRecord[];
  /** The chapter number being read. */
  chapter: number;
  /** The translation group the reader chose for this title, or ''. */
  preferredGroup: string;
  /** A release the address names outright; it stands for its number whatever the group. */
  requestedChapterId: string | null;
}) {
  const chapterByNumber = useMemo(() => {
    const map = new Map<number, MangaChapterRecord>();
    for (const c of chapters) {
      if (!map.has(c.chapter_number) || (preferredGroup && c.scanlator === preferredGroup))
        map.set(c.chapter_number, c);
    }
    if (requestedChapterId) {
      const explicit = chapters.find((record) => record.id === requestedChapterId);
      if (explicit) map.set(explicit.chapter_number, explicit);
    }
    return map;
  }, [chapters, preferredGroup, requestedChapterId]);
  // Chapter numbers are not contiguous integers (10.3, 11.1, 11.2 …), so "next"/"previous"
  // must come from the real sorted list rather than ±1.
  const sortedChapterNumbers = useMemo(
    () => [...new Set(chapters.map((c) => c.chapter_number))].sort((a, b) => a - b),
    [chapters],
  );
  // Settings › Reader › Skip read chapters / Skip filtered chapters. A release is passed
  // over when it is read, or when the title's chapter-list filter hides it; a chapter
  // number is passed over when every release of it is.
  const skipRead = useSetting(SKIP_READ_CHAPTERS, false) as boolean;
  const skipFiltered = useSetting(SKIP_FILTERED_CHAPTERS, false) as boolean;
  const skipDuplicates = useSetting(SKIP_DUPLICATE_CHAPTERS, false) as boolean;
  const [listFilter] = useProfilePreference(
    chapterFilterKey(mangaId),
    parseChapterFilter,
    DEFAULT_CHAPTER_FILTER,
  );
  const filtering = skipFiltered && isFilterActive(listFilter);
  const bookmarkTargets = useMemo(
    () => chapters.map((c) => ({ id: c.source_chapter_key, is_bookmark: c.is_bookmark })),
    [chapters],
  );
  const { isBookmarked, toggle: toggleChapterBookmark } = useChapterBookmarks(bookmarkTargets);
  // Only fetched when the filter is "Downloaded", the one filter that needs it.
  const { data: filterDownloads } = useDownloads({
    enabled: filtering && listFilter.status === 'Downloaded',
  });
  const downloadedIds: ReadonlySet<string> = useMemo(
    () =>
      new Set(
        (filterDownloads ?? [])
          .filter((d) => d.status === 'COMPLETED' && d.chapter_id)
          .map((d) => d.chapter_id),
      ),
    [filterDownloads],
  );
  const skipRelease = (record: MangaChapterRecord) =>
    (skipRead && record.is_read) ||
    (filtering &&
      !releasePassesFilter(record, listFilter, { downloaded: downloadedIds, isBookmarked }));
  const releasesByNumber = useMemo(() => {
    const map = new Map<number, MangaChapterRecord[]>();
    for (const c of chapters) map.set(c.chapter_number, [...(map.get(c.chapter_number) ?? []), c]);
    return map;
  }, [chapters]);
  const skipChapter = (n: number) =>
    (skipRead || filtering) && (releasesByNumber.get(n) ?? []).every(skipRelease);
  const nextChapterAfter = (n: number): number | null =>
    adjacentChapter(sortedChapterNumbers, n, 1, skipChapter);
  const prevChapterBefore = (n: number): number | null =>
    adjacentChapter(sortedChapterNumbers, n, -1, skipChapter);

  const currentRecord = chapterByNumber.get(chapter);

  // Settings › Reader › Skip duplicate chapters, off: each group's release of a chapter is
  // its own stop, so next and previous move between releases rather than numbers.
  const stops = useMemo(
    () => (skipDuplicates ? [] : releaseStops(chapters, preferredGroup, currentRecord?.id)),
    [skipDuplicates, chapters, preferredGroup, currentRecord?.id],
  );
  const byRelease = !skipDuplicates && !!currentRecord;
  const nextRelease = byRelease ? adjacentRelease(stops, currentRecord, 1, skipRelease) : null;
  const prevRelease = byRelease ? adjacentRelease(stops, currentRecord, -1, skipRelease) : null;
  const nextChapter = byRelease ? (nextRelease?.chapter_number ?? null) : nextChapterAfter(chapter);
  const prevChapter = byRelease
    ? (prevRelease?.chapter_number ?? null)
    : prevChapterBefore(chapter);

  // Long strip with "Skip duplicate chapters" off: the strip runs through the same stops as
  // next/previous in the paged reader, each group's release in turn. Its segments are
  // numbered by position in `stops` (stable: `keep` only swaps which release of one
  // chapter-and-group stands for it), and translated back to releases here.
  const stopIndexOf = (record: MangaChapterRecord | undefined) => {
    if (!record) return -1;
    const exact = stops.findIndex((stop) => stop.id === record.id);
    if (exact !== -1) return exact;
    const next = adjacentRelease(stops, record, 1);
    const previous = adjacentRelease(stops, record, -1);
    return stops.indexOf(
      stops.find(
        (stop) =>
          stop.chapter_number === record.chapter_number &&
          (stop.scanlator ?? '') === (record.scanlator ?? ''),
      ) ??
        next ??
        previous ??
        stops[0],
    );
  };
  const stripStop = (index: number): MangaChapterRecord | undefined => stops[index];
  const nextStopAfter = (index: number): number | null => {
    const stop = stripStop(index);
    const next = stop ? adjacentRelease(stops, stop, 1, skipRelease) : null;
    return next ? stops.indexOf(next) : null;
  };

  return {
    /** The release that stands for each chapter number. */
    chapterByNumber,
    sortedChapterNumbers,
    /** The release being read, once the list has it. */
    currentRecord,
    /** The chapter number to read after / before `n`, or null at either end. */
    nextChapterAfter,
    prevChapterBefore,
    /** Next and previous from the chapter being read. With releases as their own stops,
     * `nextRelease` / `prevRelease` name the exact release. */
    nextChapter,
    prevChapter,
    nextRelease,
    prevRelease,
    /** True when each group's release is its own stop (skip duplicates off). */
    byRelease,
    /** The long strip's view of the same stops, by position. */
    stopIndexOf,
    stripStop,
    nextStopAfter,
    isBookmarked,
    toggleChapterBookmark,
  };
}
