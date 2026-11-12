import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MangaChapterRecord } from '@projekt-manga/api-client';

const { settings, listFilter, downloads } = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  listFilter: { value: null as unknown },
  downloads: { rows: [] as { status: string; chapter_id: string }[] },
}));

vi.mock('@/lib/app-store', () => ({
  useSetting: (key: string, fallback: unknown) => settings[key] ?? fallback,
}));
vi.mock('@/lib/profile-preferences', () => ({
  useProfilePreference: (_key: string, _parse: unknown, fallback: unknown) => [
    listFilter.value ?? fallback,
    vi.fn(),
  ],
}));
vi.mock('@/lib/chapter-bookmarks', () => ({
  useChapterBookmarks: (targets: { id: string; is_bookmark?: boolean }[]) => ({
    isBookmarked: (id: string) => !!targets.find((target) => target.id === id)?.is_bookmark,
    toggle: vi.fn(),
  }),
}));
vi.mock('@/lib/shared-queries', () => ({
  useDownloads: ({ enabled }: { enabled: boolean }) => ({
    data: enabled ? downloads.rows : undefined,
  }),
}));

import { useChapterOrder } from '@/components/reader/use-chapter-order';
import { SKIP_DUPLICATE_CHAPTERS, SKIP_READ_CHAPTERS } from '@/lib/chapter-skip';
import { DEFAULT_CHAPTER_FILTER, SKIP_FILTERED_CHAPTERS } from '@/lib/chapter-filter';

const release = (
  id: string,
  chapter_number: number,
  extra: Partial<MangaChapterRecord> = {},
): MangaChapterRecord =>
  ({
    id,
    source_chapter_key: `key-${id}`,
    chapter_number,
    name: `Chapter ${chapter_number}`,
    scanlator: null,
    is_read: false,
    is_bookmark: false,
    page_count: 20,
    manga_id: 'manga-1',
    ...extra,
  }) as MangaChapterRecord;

const order = (
  chapters: MangaChapterRecord[],
  chapter: number,
  options: { preferredGroup?: string; requestedChapterId?: string | null } = {},
) =>
  renderHook(() =>
    useChapterOrder({
      mangaId: 'manga-1',
      chapters,
      chapter,
      preferredGroup: options.preferredGroup ?? '',
      requestedChapterId: options.requestedChapterId ?? null,
    }),
  ).result.current;

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  listFilter.value = null;
  downloads.rows = [];
});

describe('the order chapters are read in', () => {
  const plain = [release('a', 10.3), release('b', 11.1), release('c', 11.2), release('d', 12)];

  it('moves through the real numbers, not by one', () => {
    const middle = order(plain, 11.1);
    expect(middle.prevChapter).toBe(10.3);
    expect(middle.nextChapter).toBe(11.2);
    expect(middle.currentRecord?.id).toBe('b');
  });

  it('ends at either end of the list', () => {
    expect(order(plain, 10.3).prevChapter).toBeNull();
    expect(order(plain, 12).nextChapter).toBeNull();
  });

  it('answers nothing before the list has arrived', () => {
    const empty = order([], 1);
    expect(empty.currentRecord).toBeUndefined();
    expect(empty.nextChapter).toBeNull();
    expect(empty.prevChapter).toBeNull();
    expect(empty.byRelease).toBe(false);
  });

  it('passes over read chapters when asked to, but still moves on when all are read', () => {
    settings[SKIP_READ_CHAPTERS] = true;
    const chapters = [release('a', 1), release('b', 2, { is_read: true }), release('c', 3)];
    expect(order(chapters, 1).nextChapter).toBe(3);
    expect(order(chapters, 3).prevChapter).toBe(1);

    const allRead = chapters.map((chapter) => ({ ...chapter, is_read: true }));
    expect(order(allRead, 1).nextChapter).toBe(2);
  });

  it("passes over chapters the title's list filter hides, when asked to", () => {
    settings[SKIP_FILTERED_CHAPTERS] = true;
    listFilter.value = { ...DEFAULT_CHAPTER_FILTER, status: 'Downloaded' };
    downloads.rows = [
      { status: 'COMPLETED', chapter_id: 'a' },
      { status: 'COMPLETED', chapter_id: 'c' },
    ];
    const chapters = [release('a', 1), release('b', 2), release('c', 3)];
    expect(order(chapters, 1).nextChapter).toBe(3);

    // The same filter does nothing while the setting is off.
    settings[SKIP_FILTERED_CHAPTERS] = false;
    expect(order(chapters, 1).nextChapter).toBe(2);
  });
});

describe('a chapter several groups released', () => {
  const chapters = [
    release('1', 1),
    release('2-alpha', 2, { scanlator: 'Alpha' }),
    release('2-beta', 2, { scanlator: 'Beta' }),
    release('3', 3),
  ];

  it("is read in the preferred group's release", () => {
    expect(order(chapters, 2).currentRecord?.id).toBe('2-alpha');
    expect(order(chapters, 2, { preferredGroup: 'Beta' }).currentRecord?.id).toBe('2-beta');
  });

  it('is read in the release the address names, whatever the group', () => {
    const named = order(chapters, 2, { preferredGroup: 'Alpha', requestedChapterId: '2-beta' });
    expect(named.currentRecord?.id).toBe('2-beta');
  });

  it("visits each group's release in turn by default", () => {
    const first = order(chapters, 1);
    expect(first.byRelease).toBe(true);
    expect(first.nextRelease?.id).toBe('2-alpha');

    const alpha = order(chapters, 2);
    expect(alpha.nextChapter).toBe(2);
    expect(alpha.nextRelease?.id).toBe('2-beta');
    expect(alpha.prevRelease?.id).toBe('1');

    const beta = order(chapters, 2, { requestedChapterId: '2-beta' });
    expect(beta.nextRelease?.id).toBe('3');
    expect(beta.prevRelease?.id).toBe('2-alpha');
  });

  it('is one stop when duplicates are skipped', () => {
    settings[SKIP_DUPLICATE_CHAPTERS] = true;
    const alpha = order(chapters, 2);
    expect(alpha.byRelease).toBe(false);
    expect(alpha.nextRelease).toBeNull();
    expect(alpha.nextChapter).toBe(3);
    expect(alpha.prevChapter).toBe(1);
  });

  it('gives the long strip the same stops by position', () => {
    const strip = order(chapters, 2);
    const index = strip.stopIndexOf(strip.currentRecord);
    expect(strip.stripStop(index)?.id).toBe('2-alpha');
    const next = strip.nextStopAfter(index);
    expect(next).not.toBeNull();
    expect(strip.stripStop(next!)?.id).toBe('2-beta');
    expect(strip.nextStopAfter(strip.stopIndexOf(chapters[3]))).toBeNull();
    expect(strip.stopIndexOf(undefined)).toBe(-1);
  });
});
