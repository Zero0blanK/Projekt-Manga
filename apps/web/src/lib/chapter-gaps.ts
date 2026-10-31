import {
  markPreviousChaptersAsRead,
  type ChapterBulkPayload,
  type MangaChapterRecord,
} from '@projekt-manga/api-client';
import { getSetting } from '@/lib/app-store';

/** Settings › Reader: mark a chapter's other releases read along with it. Off by default:
 * some readers keep a second group's release unread on purpose. */
export const MARK_DUPLICATES_READ = 'markDuplicatesRead';
/** Settings › Reader: show where whole chapter numbers are missing from the list. */
export const SHOW_CHAPTER_GAPS = 'showChapterGaps';

/**
 * How many whole chapter numbers are missing just below each chapter number: 10 after 7
 * means 8 and 9 are missing. Decimals (7.5) are extras and never count as a gap, and a
 * chapter listed by several groups counts once.
 */
export function missingBefore(chapterNumbers: number[]): Map<number, number> {
  const whole = [...new Set(chapterNumbers.filter(Number.isFinite).map(Math.floor))].sort(
    (a, b) => a - b,
  );
  const gaps = new Map<number, number>();
  for (let i = 1; i < whole.length; i++) {
    const missing = whole[i] - whole[i - 1] - 1;
    if (missing > 0) gaps.set(whole[i], missing);
  }
  return gaps;
}

/** The unread releases of `chapterNumber` other than the one just read. */
export function duplicateTargets(
  records: MangaChapterRecord[],
  chapterNumber: number,
  exceptId: string,
): MangaChapterRecord[] {
  return records.filter(
    (record) =>
      record.chapter_number === chapterNumber && record.id !== exceptId && !record.is_read,
  );
}

export function bulkPayload(record: MangaChapterRecord, source: string): ChapterBulkPayload {
  return {
    id: record.source_chapter_key,
    name: record.name ?? undefined,
    url: record.url,
    scanlator: record.scanlator ?? undefined,
    chapter_number: record.chapter_number,
    last_page_read: record.last_page_read,
    page_count: record.page_count ?? undefined,
    fetched_at: record.fetched_at ?? undefined,
    release_date: record.release_date ?? undefined,
    source,
  };
}

/**
 * With "Mark duplicates read" on, marks the other releases of a chapter that was just read.
 * Returns the ids it marked so a list can update without refetching; failures are left
 * to the next refresh, since the chapter the reader actually read is already saved.
 */
export async function markDuplicatesRead(
  manga: { id: string; slug: string; title: string; source: string },
  records: MangaChapterRecord[],
  chapterNumber: number,
  readId: string,
): Promise<string[]> {
  if (!getSetting(MARK_DUPLICATES_READ, false)) return [];
  const targets = duplicateTargets(records, chapterNumber, readId);
  if (targets.length === 0) return [];
  const result = await markPreviousChaptersAsRead(
    manga.slug,
    targets.map((record) => bulkPayload(record, manga.source)),
    { manga_id: manga.id, title: manga.title },
  );
  const failed = new Set(result.failed_source_chapter_keys);
  return targets.filter((record) => !failed.has(record.source_chapter_key)).map((r) => r.id);
}
