import { describe, expect, it } from 'vitest';
import {
  parseChapterParam,
  parsePageNotes,
  parseReaderPresets,
  selectChapterRelease,
} from '@/lib/reader-preferences';
import type { MangaChapterRecord } from '@projekt-manga/api-client';

describe('reader release identity', () => {
  it('preserves chapter zero and decimal numbers in resume URLs', () => {
    expect(parseChapterParam('0')).toBe(0);
    expect(parseChapterParam('0.5')).toBe(0.5);
    for (const value of [null, '', ' ', '-1', 'Infinity', 'invalid']) {
      expect(parseChapterParam(value)).toBeUndefined();
    }
  });
  const releases = [
    { id: 'one-a', chapter_number: 1, scanlator: 'A' },
    { id: 'one-b', chapter_number: 1, scanlator: 'B' },
    { id: 'two-a', chapter_number: 2, scanlator: 'A' },
  ] as MangaChapterRecord[];
  it('chooses an explicit release even when a different group is preferred', () => {
    expect(selectChapterRelease(releases, 1, 'A', 'one-b')?.id).toBe('one-b');
  });
  it('does not substitute another release for an invalid explicit ID', () => {
    expect(selectChapterRelease(releases, 1, 'A', 'another-title')).toBeUndefined();
  });
  it('prefers the saved group and falls back only when that group is missing', () => {
    expect(selectChapterRelease(releases, 1, 'B')?.id).toBe('one-b');
    expect(selectChapterRelease(releases, 2, 'B')?.id).toBe('two-a');
  });
});
describe('local reader preference validation', () => {
  it('retains notes as plain strings and rejects invalid page identities', () => {
    const note = {
      source: 'source',
      mangaId: 'title',
      chapterId: 'chapter',
      page: 3,
      text: '<b>literal text</b>',
    };
    expect(parsePageNotes([note])).toEqual([note]);
    expect(parsePageNotes([{ ...note, page: -1 }])).toEqual([]);
    expect(parsePageNotes([{ ...note, chapterId: '' }])).toEqual([]);
  });
  it('rejects presets with unsafe resource bounds or unknown layouts', () => {
    const preset = {
      name: 'Normal',
      pageLayout: 'Single page',
      readingDirection: 'Right to left',
      zoomBehavior: 'Smart',
      brightness: 100,
      stripGap: 8,
      pagePrefetchAhead: 4,
      chapterPrefetchCount: 1,
    };
    expect(parseReaderPresets([preset])).toEqual([preset]);
    expect(parseReaderPresets([{ ...preset, pagePrefetchAhead: 1000 }])).toEqual([]);
    expect(parseReaderPresets([{ ...preset, pageLayout: 'unsupported' }])).toEqual([]);
  });
});
