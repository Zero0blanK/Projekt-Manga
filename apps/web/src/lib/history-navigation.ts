import type { HistoryEntry } from '@projekt-manga/api-client';

type HistoryLocation = Pick<
  HistoryEntry,
  | 'manga_id'
  | 'in_library'
  | 'manga_slug'
  | 'source_manga_id'
  | 'source'
  | 'chapter_id'
  | 'chapter_number'
  | 'last_page_read'
>;

export function historyTitleHref(entry: HistoryLocation): string {
  if (entry.manga_id && entry.in_library !== false) {
    return `/manga/${encodeURIComponent(entry.manga_id)}`;
  }
  return `/discover/preview/${encodeURIComponent(entry.source)}/${encodeURIComponent(entry.source_manga_id || entry.manga_slug)}`;
}

export function historyResumeHref(entry: HistoryLocation): string {
  const page = entry.last_page_read > 0 ? `&page=${entry.last_page_read}` : '';
  if (entry.manga_id && entry.in_library !== false) {
    const chapter = entry.chapter_number;
    if (entry.chapter_id)
      return `/reader/${encodeURIComponent(entry.manga_id)}?${chapter !== undefined ? `ch=${chapter}&` : ''}chapterId=${encodeURIComponent(entry.chapter_id)}${page}`;
    return `/reader/${encodeURIComponent(entry.manga_id)}${chapter !== undefined ? `?ch=${chapter}${page}` : ''}`;
  }

  const base = `${historyTitleHref(entry)}/read`;
  // Chapter identity survives even when an older history row's placeholder metadata
  // says Chapter 0. The source reader resolves it against the current source list.
  if (entry.chapter_id) return `${base}?chapterId=${encodeURIComponent(entry.chapter_id)}${page}`;
  if (entry.chapter_number !== undefined) return `${base}?ch=${entry.chapter_number}${page}`;
  return base;
}
