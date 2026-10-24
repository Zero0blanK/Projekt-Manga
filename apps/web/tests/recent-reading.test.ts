import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';
import { mostRecentlyReadLibraryManga } from '@/lib/recent-reading';

function manga(id: string, source = 'source-a'): Manga {
  return {
    id,
    slug: id,
    title: id,
    source,
    authors: null,
    artists: null,
    groups: null,
    chapters: 1,
    latestChapter: '',
    latestChapterNum: 1,
    updatedAt: '2026-01-01',
    status: 'Ongoing',
    tags: [],
    color: '',
    accent: '',
    synopsis: '',
    rating: null,
    thumbnailUrl: null,
    inLibrary: true,
  };
}

function history(
  mangaId: string | undefined,
  slug: string,
  lastRead: string,
  source = 'source-a',
): HistoryEntry {
  return {
    id: `${source}-${slug}`,
    manga_id: mangaId,
    manga_slug: slug,
    source,
    chapter_id: 'chapter',
    pages_read: 1,
    time_read: 1,
    last_read: lastRead,
    read_at: lastRead,
    last_page_read: 1,
    page_count: 10,
  };
}

describe('most recently read library title', () => {
  it('chooses actual last read, regardless of library and history ordering', () => {
    const library = [manga('first'), manga('second')];
    expect(
      mostRecentlyReadLibraryManga(
        [
          history('first', 'first', '2026-01-01T00:00:00Z'),
          history('second', 'second', '2026-02-01T00:00:00Z'),
        ],
        library,
      ),
    ).toEqual(library[1]);
  });

  it('matches an unlinked history row by both source and slug', () => {
    const library = [manga('same', 'source-a'), manga('same', 'source-b')];
    expect(
      mostRecentlyReadLibraryManga(
        [history(undefined, 'same', '2026-02-01T00:00:00Z', 'source-b')],
        library,
      ),
    ).toEqual(library[1]);
  });

  it('ignores titles no longer in the library', () => {
    const library = [manga('kept')];
    expect(
      mostRecentlyReadLibraryManga(
        [
          history('removed', 'removed', '2026-03-01T00:00:00Z'),
          history('kept', 'kept', '2026-02-01T00:00:00Z'),
        ],
        library,
      ),
    ).toEqual(library[0]);
  });
});
