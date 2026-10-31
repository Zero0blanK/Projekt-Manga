import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MangaChapterRecord } from '@projekt-manga/api-client';

const { markPreviousChaptersAsRead, settings } = vi.hoisted(() => ({
  markPreviousChaptersAsRead: vi.fn(),
  settings: {} as Record<string, unknown>,
}));
vi.mock('@projekt-manga/api-client', () => ({ markPreviousChaptersAsRead }));
vi.mock('@/lib/app-store', () => ({
  getSetting: (key: string, fallback: unknown) => settings[key] ?? fallback,
}));

import { duplicateTargets, markDuplicatesRead, missingBefore } from '@/lib/chapter-gaps';

const record = (id: string, chapter_number: number, is_read = false) =>
  ({
    id,
    source_chapter_key: `key-${id}`,
    chapter_number,
    is_read,
    url: `/c/${id}`,
    name: null,
    scanlator: null,
    last_page_read: 0,
    page_count: null,
    fetched_at: null,
    release_date: null,
  }) as unknown as MangaChapterRecord;

const manga = { id: 'm', slug: 'slug', title: 'Title', source: 'src' };

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(settings)) delete settings[key];
});

describe('chapter gaps', () => {
  it('counts whole numbers missing below each chapter, ignoring extras and duplicates', () => {
    expect([...missingBefore([1, 2, 2, 2.5, 5, 6, 10])]).toEqual([
      [5, 2],
      [10, 3],
    ]);
    expect(missingBefore([1, 1.5, 2, 3]).size).toBe(0);
    // An extra standing in for a whole number still fills it.
    expect(missingBefore([1, 2.5, 3]).size).toBe(0);
  });
});

describe('mark duplicates read', () => {
  const records = [record('a', 3), record('b', 3), record('c', 3, true), record('d', 4)];

  it('targets the other unread releases of the same chapter', () => {
    expect(duplicateTargets(records, 3, 'a').map((r) => r.id)).toEqual(['b']);
  });

  it('does nothing while the setting is off', async () => {
    expect(await markDuplicatesRead(manga, records, 3, 'a')).toEqual([]);
    expect(markPreviousChaptersAsRead).not.toHaveBeenCalled();
  });

  it('marks them through the bulk endpoint and reports only the ones that saved', async () => {
    settings.markDuplicatesRead = true;
    const many = [...records, record('e', 3)];
    markPreviousChaptersAsRead.mockResolvedValue({
      count: 1,
      failed_source_chapter_keys: ['key-e'],
    });
    expect(await markDuplicatesRead(manga, many, 3, 'a')).toEqual(['b']);
    expect(markPreviousChaptersAsRead).toHaveBeenCalledWith(
      'slug',
      [
        expect.objectContaining({ id: 'key-b', chapter_number: 3, source: 'src' }),
        expect.objectContaining({ id: 'key-e' }),
      ],
      { manga_id: 'm', title: 'Title' },
    );
  });
});
