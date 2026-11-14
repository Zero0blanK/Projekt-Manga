import { describe, expect, it } from 'vitest';
import {
  chapterDateSplits,
  separateChapterDates,
  sourceChapterListSchema,
} from '@projekt-manga/schemas';

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const day = 86_400_000;
const chapter = (name: string, chapter_number: number, release_date = '') => ({
  name,
  chapter_number,
  release_date,
});

describe('dates stuck to the end of a chapter name', () => {
  it('takes relative and calendar dates off the name, with the number put right', () => {
    const fixed = separateChapterDates(
      [
        chapter('Chapter 1032 weeks ago', 1032),
        chapter('Chapter 105Just now', 105),
        chapter('Chapter 104last week', 104),
        chapter('Chapter 101Oct 14, 2026', 101),
      ],
      NOW,
    );
    expect(fixed.map((c) => [c.name, c.chapter_number])).toEqual([
      ['Chapter 103', 103],
      ['Chapter 105', 105],
      ['Chapter 104', 104],
      ['Chapter 101', 101],
    ]);
    expect(fixed[0].release_date).toBe(new Date(Date.UTC(2026, 9, 31)).toISOString());
    expect(fixed[3].release_date).toBe(new Date(Date.UTC(2026, 9, 14)).toISOString());
  });

  it('gives the same date when read again later the same day', () => {
    const [first] = separateChapterDates([chapter('Chapter 9 3 days ago', 9)], NOW);
    const [again] = separateChapterDates([chapter('Chapter 9 3 days ago', 9)], NOW + 3_600_000);
    expect(again.release_date).toBe(first.release_date);
    expect(+new Date(first.release_date)).toBeLessThanOrEqual(NOW - 3 * day);
  });

  it('splits run-together digits only where the amount is one a site would show', () => {
    // 10 + "32 weeks" is not something a site writes; 103 + "2 weeks" is.
    expect(chapterDateSplits('Chapter 1032 weeks ago', NOW).map((s) => s.name)).toEqual([
      'Chapter 103',
    ]);
  });

  it('picks the reading that fits the chapters around it', () => {
    // "1012 days": 101 + 12 days, or 10 + 12… only 101 sits beside 100 and 102.
    const fixed = separateChapterDates(
      [
        chapter('Chapter 102', 102),
        chapter('Chapter 1012 days ago', 1012),
        chapter('Chapter 100', 100),
      ],
      NOW,
    );
    expect(fixed[1].name).toBe('Chapter 101');
    expect(fixed[1].chapter_number).toBe(101);
  });

  it('leaves titles alone: words that only look like dates, and chapters already dated', () => {
    const chapters = [
      chapter('Chapter 12: Snow', 12),
      chapter('Chapter 3: Last week', 3),
      chapter('Chapter 4 2 days ago', 4, '2026-01-01T00:00:00.000Z'),
    ];
    expect(separateChapterDates(chapters, NOW)).toBe(chapters);
  });

  it("is part of reading a source's chapter list", () => {
    const [parsed] = sourceChapterListSchema.parse([
      { id: 'c-99', name: 'Chapter 99Sep 30, 2026', chapter_number: 99 },
    ]);
    expect(parsed.name).toBe('Chapter 99');
    expect(parsed.release_date).toBe(new Date(Date.UTC(2026, 8, 30)).toISOString());
  });
});
