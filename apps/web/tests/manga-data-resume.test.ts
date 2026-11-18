import { describe, expect, it } from 'vitest';
import { resumePosition } from '@/lib/manga-data';
import type { MangaChapterRecord } from '@projekt-manga/api-client';

const chapter = (n: number, state: Partial<MangaChapterRecord> = {}) =>
  ({
    id: `c${n}`,
    source_chapter_key: `c${n}`,
    name: `Chapter ${n}`,
    chapter_number: n,
    is_read: false,
    last_page_read: 0,
    page_count: 10,
    ...state,
  }) as MangaChapterRecord;

describe('resumePosition', () => {
  it('starts from the top when nothing was read', () => {
    expect(resumePosition([chapter(1), chapter(2)])).toEqual({
      currentChapter: undefined,
      currentChapterTitle: undefined,
      currentPage: undefined,
    });
  });

  it('resumes a chapter read part of the way, at its page', () => {
    expect(resumePosition([chapter(1, { last_page_read: 4 }), chapter(2)])).toMatchObject({
      currentChapter: 1,
      currentPage: 4,
    });
  });

  it('moves on to the next chapter once one is read', () => {
    expect(
      resumePosition([chapter(1, { is_read: true, last_page_read: 10 }), chapter(2)]),
    ).toMatchObject({
      currentChapter: 2,
      currentPage: undefined,
      currentChapterTitle: 'Chapter 2',
    });
  });
});
