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
export type ChapterListFilter = { status: ChapterStatus; group: string };
export const DEFAULT_CHAPTER_FILTER: ChapterListFilter = { status: 'All', group: 'All' };
export const SKIP_FILTERED_CHAPTERS = 'readerSkipFilteredChapters';

export const chapterFilterKey = (mangaId: string) => `chapter-list-filter:${mangaId}`;

export function parseChapterFilter(raw: unknown): ChapterListFilter {
  if (!raw || typeof raw !== 'object') return DEFAULT_CHAPTER_FILTER;
  const { status, group } = raw as Record<string, unknown>;
  return {
    status: (CHAPTER_STATUS_FILTERS as readonly unknown[]).includes(status)
      ? (status as ChapterStatus)
      : 'All',
    group: typeof group === 'string' && group.length <= 200 ? group : 'All',
  };
}

export const isFilterActive = (filter: ChapterListFilter) =>
  filter.status !== 'All' || filter.group !== 'All';

/** Whether one release shows under the filter, as the chapter list decides it. */
export function releasePassesFilter(
  record: Pick<MangaChapterRecord, 'id' | 'source_chapter_key' | 'is_read' | 'scanlator'>,
  filter: ChapterListFilter,
  context: { downloaded: ReadonlySet<string>; isBookmarked: (key: string) => boolean },
): boolean {
  if (filter.group !== 'All' && knownGroup(record.scanlator) !== filter.group) return false;
  if (filter.status === 'Downloaded') return context.downloaded.has(record.id);
  if (filter.status === 'Bookmarked') return context.isBookmarked(record.source_chapter_key);
  return passesChapterStatusFilter(record.is_read, filter.status as ChapterStatusFilter);
}
