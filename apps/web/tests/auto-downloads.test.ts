import { describe, expect, it } from 'vitest';
import {
  autoDownloadApplies,
  categoryScope,
  deleteAfterReadTarget,
  downloadAheadTargets,
} from '@/lib/auto-downloads';

const chapter = (number: number, extra: { is_bookmark?: boolean } = {}) => ({
  id: `row-${number}`,
  source_chapter_key: `key-${number}`,
  chapter_number: number,
  ...extra,
});
const chapters = [1, 2, 2.5, 3, 4, 5].map((n) => chapter(n));
const numbers = chapters.map((c) => c.chapter_number);
const pick = (n: number) => chapters.find((c) => c.chapter_number === n);

describe('automatic download rules', () => {
  it('downloads new chapters for every title, one category, or none', () => {
    const members = { Favourites: ['manga-1'] };
    expect(autoDownloadApplies('off', 'manga-1', members)).toBe(false);
    expect(autoDownloadApplies('all', 'manga-2', members)).toBe(true);
    expect(autoDownloadApplies(categoryScope('Favourites'), 'manga-1', members)).toBe(true);
    expect(autoDownloadApplies(categoryScope('Favourites'), 'manga-2', members)).toBe(false);
    // A category deleted since the setting was chosen downloads nothing.
    expect(autoDownloadApplies(categoryScope('Gone'), 'manga-1', members)).toBe(false);
  });

  it('downloads ahead the next chapters, skipping ones already downloaded or queued', () => {
    const have = new Set(['key-3']);
    expect(downloadAheadTargets(numbers, pick, 2, 3, have).map((c) => c.chapter_number)).toEqual([
      2.5, 4, 5,
    ]);
    expect(downloadAheadTargets(numbers, pick, 5, 3, have)).toEqual([]);
    expect(downloadAheadTargets(numbers, pick, 1, 0, have)).toEqual([]);
  });

  it('deletes the chapter just read, or the one before it, but never a bookmarked one', () => {
    expect(deleteAfterReadTarget('off', 3, numbers, pick)).toBeNull();
    expect(deleteAfterReadTarget('immediately', 3, numbers, pick)?.chapter_number).toBe(3);
    expect(deleteAfterReadTarget('afterNext', 3, numbers, pick)?.chapter_number).toBe(2.5);
    // Nothing before the first chapter.
    expect(deleteAfterReadTarget('afterNext', 1, numbers, pick)).toBeNull();

    const bookmarked = [chapter(1, { is_bookmark: true }), chapter(2)];
    const pickBookmarked = (n: number) => bookmarked.find((c) => c.chapter_number === n);
    expect(deleteAfterReadTarget('afterNext', 2, [1, 2], pickBookmarked)).toBeNull();
    expect(deleteAfterReadTarget('immediately', 2, [1, 2], pickBookmarked)?.chapter_number).toBe(2);
  });
});
