import type { MangaChapterRecord } from '@projekt-manga/api-client';
import { knownGroup, passesChapterStatusFilter, type ChapterStatusFilter } from '@/lib/manga-data';

/**
 * A title's chapter-list filter (status and scanlation group), kept per title so it
 * survives leaving the page, and so the reader can skip what it hides (Settings › Reader ›
 * Skip filtered chapters).
 */
export const CHAPTER_STATUS_FILTERS = [
  'All',
  'Unread',
  'Read',
  'Downloaded',
  'Bookmarked',
] as const;
export type ChapterStatus = (typeof CHAPTER_STATUS_FILTERS)[number];
/** `group` shows one scanlation group; `hiddenGroups` hides the ones the reader never wants. */
export type ChapterListFilter = { status: ChapterStatus; group: string; hiddenGroups: string[] };
export const DEFAULT_CHAPTER_FILTER: ChapterListFilter = {
  status: 'All',
  group: 'All',
  hiddenGroups: [],
};
export const SKIP_FILTERED_CHAPTERS = 'readerSkipFilteredChapters';

export const chapterFilterKey = (mangaId: string) => `chapter-list-filter:${mangaId}`;

export function parseChapterFilter(raw: unknown): ChapterListFilter {
  if (!raw || typeof raw !== 'object') return DEFAULT_CHAPTER_FILTER;
  const { status, group, hiddenGroups } = raw as Record<string, unknown>;
  return {
    status: (CHAPTER_STATUS_FILTERS as readonly unknown[]).includes(status)
      ? (status as ChapterStatus)
      : 'All',
    group: typeof group === 'string' && group.length <= 200 ? group : 'All',
    hiddenGroups: Array.isArray(hiddenGroups)
      ? hiddenGroups
          .filter((entry): entry is string => typeof entry === 'string' && entry.length <= 200)
          .slice(0, 100)
      : [],
  };
}

export const isFilterActive = (filter: ChapterListFilter) =>
  filter.status !== 'All' || filter.group !== 'All' || filter.hiddenGroups.length > 0;

/** Whether one release shows under the filter, as the chapter list decides it. */
export function releasePassesFilter(
  record: Pick<MangaChapterRecord, 'id' | 'source_chapter_key' | 'is_read' | 'scanlator'>,
  filter: ChapterListFilter,
  context: { downloaded: ReadonlySet<string>; isBookmarked: (key: string) => boolean },
): boolean {
  const group = knownGroup(record.scanlator);
  if (filter.group !== 'All' && group !== filter.group) return false;
  if (filter.hiddenGroups.includes(group)) return false;
  if (filter.status === 'Downloaded') return context.downloaded.has(record.id);
  if (filter.status === 'Bookmarked') return context.isBookmarked(record.source_chapter_key);
  return passesChapterStatusFilter(record.is_read, filter.status as ChapterStatusFilter);
}
