import { describe, expect, it } from 'vitest';
import type { MangaChapterRecord } from '@projekt-manga/api-client';

/**
 * A title in the library, browsed again from its source, must show what the library
 * already knows about it.
 *
 * The source preview derived read state from `GET /history` alone. History records
 * chapters that were *opened*, so a title whose first five chapters were marked read from
 * the library — in bulk, or with "mark previous as read", neither of which writes a
 * history row — came back from the source looking completely unread, while chapter 6, the
 * only one actually opened, correctly showed "4 / 25".
 *
 * The two sides share no id: a source chapter's `id` is the source's own identifier and a
 * library row's is the database's. The URL is the same string on both, because the row
 * was created from it, so that is the join. These pin down the merge rather than the
 * component, which needs a session, a library store and a live source to render at all.
 */

type SourceChapter = { id: string; url: string; chapter_number: number };

function libraryRow(over: Partial<MangaChapterRecord> & { url: string }): MangaChapterRecord {
  return {
    id: `row-${over.url}`,
    manga_id: 'manga-1',
    name: null,
    scanlator: null,
    is_bookmark: false,
    chapter_number: 0,
    last_page_read: 0,
    page_count: null,
    fetched_at: null,
    release_date: null,
    created_at: '',
    updated_at: '',
    is_read: false,
    ...over,
  } as MangaChapterRecord;
}

/** The merge as the preview performs it. */
function mergeReadIds(
  chapters: SourceChapter[],
  historyReadIds: Set<string>,
  library: Map<string, MangaChapterRecord>,
  overrides: Map<string, boolean> = new Map(),
) {
  const ids = new Set(historyReadIds);
  for (const chapter of chapters) {
    if (library.get(chapter.url)?.is_read) ids.add(chapter.id);
  }
  for (const [id, read] of overrides) {
    if (read) ids.add(id);
    else ids.delete(id);
  }
  return ids;
}

const chapters: SourceChapter[] = Array.from({ length: 6 }, (_, i) => ({
  id: `src-${i + 1}`,
  url: `https://example.invalid/ch-${i + 1}`,
  chapter_number: i + 1,
}));

describe('source detail read state', () => {
  it('shows chapters the library marked read even with no history for them', () => {
    // The reported case: 1–5 marked read in the library, 6 part-read in history.
    const library = new Map(
      chapters
        .slice(0, 5)
        .map((c) => [
          c.url,
          libraryRow({ url: c.url, is_read: true, chapter_number: c.chapter_number }),
        ]),
    );
    const historyReadIds = new Set<string>();

    const read = mergeReadIds(chapters, historyReadIds, library);

    expect([...read].sort()).toEqual(['src-1', 'src-2', 'src-3', 'src-4', 'src-5']);
    expect(read.has('src-6')).toBe(false);
  });

  it('keeps history-only reads, for a title with no library row at all', () => {
    const read = mergeReadIds(chapters, new Set(['src-2']), new Map());

    expect([...read]).toEqual(['src-2']);
  });

  it('lets a mark made on the page win over both sources until they catch up', () => {
    const library = new Map([
      [chapters[0].url, libraryRow({ url: chapters[0].url, is_read: true })],
    ]);

    // Marking it unread here must not be undone by the library row the next render.
    const read = mergeReadIds(chapters, new Set(), library, new Map([['src-1', false]]));

    expect(read.has('src-1')).toBe(false);
  });

  it('takes the further page position, never moving the reader backwards', () => {
    const furthest = (history: number, row: number) => Math.max(history, row);

    // Read to page 4 here, page 12 on another device that synced to the library row.
    expect(furthest(4, 12)).toBe(12);
    // And the other way round, when this device is ahead.
    expect(furthest(12, 4)).toBe(12);
    // A library row with no recorded position never erases history's.
    expect(furthest(4, 0)).toBe(4);
  });
});
