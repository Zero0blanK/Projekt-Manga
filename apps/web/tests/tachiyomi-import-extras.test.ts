import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MangaChapterRecord } from '@projekt-manga/api-client';

const api = vi.hoisted(() => ({
  getManga: vi.fn(),
  getMangaChapters: vi.fn(),
  getConnectedTrackers: vi.fn(),
  linkMangaToTracker: vi.fn(),
  markPreviousChaptersAsRead: vi.fn(),
  markChapterByLastPage: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', () => api);

// Node's own (file-backed) localStorage global shadows jsdom's here; use an in-memory one,
// as splash-gating.test.ts does.
const values = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => Array.from(values.keys())[index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, String(value)),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage });
Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage });

import { getAppState } from '@/lib/app-store';
import {
  applyTachiyomiChapterState,
  applyTachiyomiImportExtras,
  applyPendingImportedChapterStates,
  clearTachiyomiImportExtras,
  saveTachiyomiImportExtras,
} from '@/lib/tachiyomi-backup/extras';
import { sourceNameOfUnmatched } from '@/lib/tachiyomi-backup/stored-names';

const extras = {
  categories: [
    {
      name: 'Weekly',
      titles: [
        { source: 'src', slug: 'a' },
        { source: 'src', slug: 'missing' },
      ],
    },
  ],
  trackers: [
    { source: 'src', slug: 'a', tracker: 'ANILIST' as const, tracker_media_id: '1' },
    { source: 'src', slug: 'a', tracker: 'KITSU' as const, tracker_media_id: '2' },
  ],
  chapterNumbers: [
    { source: 'src', slug: 'b', read: [1, 2], lastPage: [[3, 4]] as Array<[number, number]> },
  ],
};

const record = (id: string, chapter_number: number): MangaChapterRecord => ({
  id,
  source: 'src',
  manga_slug: 'b',
  source_chapter_key: `key-${id}`,
  manga_id: 'm-b',
  url: '',
  name: null,
  scanlator: null,
  is_read: false,
  is_bookmark: false,
  chapter_number,
  last_page_read: 0,
  page_count: null,
  fetched_at: null,
  release_date: null,
  created_at: '',
  updated_at: '',
});

describe('Tachiyomi import extras', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    api.getManga.mockResolvedValue([
      { id: 'm-a', source: 'src', slug: 'a' },
      { id: 'm-b', source: 'src', slug: 'b' },
    ]);
    api.getConnectedTrackers.mockResolvedValue([{ tracker: 'ANILIST' }]);
    api.linkMangaToTracker.mockResolvedValue({});
    api.markPreviousChaptersAsRead.mockResolvedValue({ count: 2, failed_source_chapter_keys: [] });
    api.markChapterByLastPage.mockResolvedValue({ count: 1 });
  });

  it('applies only for its own job and owner, once', async () => {
    saveTachiyomiImportExtras('job-1', 'anonymous', extras);
    expect(await applyTachiyomiImportExtras('job-2', 'anonymous')).toBeNull();
    expect(await applyTachiyomiImportExtras('job-1', 'someone-else')).toBeNull();

    const applied = await applyTachiyomiImportExtras('job-1', 'anonymous');
    expect(applied).toEqual({ categories: 1, trackerLinks: 1, skippedTrackerLinks: 1 });
    expect(getAppState().customCategories).toContain('Weekly');
    expect(getAppState().categoryMembers.Weekly).toEqual(['m-a']);
    expect(api.linkMangaToTracker).toHaveBeenCalledWith('m-a', {
      tracker: 'ANILIST',
      tracker_media_id: '1',
    });
    expect(await applyTachiyomiImportExtras('job-1', 'anonymous')).toBeNull();
  });

  it('reuses an existing category of the same name and is idempotent on retry', async () => {
    const { setState } = await import('@/lib/app-store');
    setState({ customCategories: ['weekly'], categoryMembers: { weekly: ['m-old'] } });
    saveTachiyomiImportExtras('job-1', 'anonymous', extras);
    await applyTachiyomiImportExtras('job-1', 'anonymous');
    // Applied a second time, nothing is duplicated.
    saveTachiyomiImportExtras('job-1', 'anonymous', extras);
    await applyTachiyomiImportExtras('job-1', 'anonymous');
    expect(getAppState().customCategories.filter((c) => c.toLowerCase() === 'weekly')).toEqual([
      'weekly',
    ]);
    expect(getAppState().categoryMembers.weekly).toEqual(['m-old', 'm-a']);
  });

  it('is dropped when the restore fails', async () => {
    saveTachiyomiImportExtras('job-1', 'anonymous', extras);
    clearTachiyomiImportExtras('job-1');
    expect(await applyTachiyomiImportExtras('job-1', 'anonymous')).toBeNull();
  });

  it('marks chapters by number after the first sync, once', async () => {
    saveTachiyomiImportExtras('job-1', 'anonymous', extras);
    await applyTachiyomiImportExtras('job-1', 'anonymous');
    const manga = { id: 'm-b', slug: 'b', source: 'src' };

    // Not synced yet: the state waits.
    expect(await applyTachiyomiChapterState('anonymous', manga, [])).toBeNull();

    const rows = [record('1', 1), record('2', 2), record('3', 3), record('4', 4)];
    const marked = await applyTachiyomiChapterState('anonymous', manga, rows);
    expect(marked?.map((row) => [row.is_read, row.last_page_read])).toEqual([
      [true, 0],
      [true, 0],
      [false, 4],
      [false, 0],
    ]);
    expect(
      api.markPreviousChaptersAsRead.mock.calls[0][1].map((c: { id: string }) => c.id),
    ).toEqual(['key-1', 'key-2']);
    expect(api.markChapterByLastPage).toHaveBeenCalledWith('b', 'key-3', 4, expect.any(Object));
    expect(await applyTachiyomiChapterState('anonymous', manga, rows)).toBeNull();
  });

  it('marks a title the library update synced, without waiting for its page to open', async () => {
    saveTachiyomiImportExtras('job-1', 'anonymous', extras);
    await applyTachiyomiImportExtras('job-1', 'anonymous');
    const rows = [record('1', 1), record('2', 2), record('3', 3)];
    api.getMangaChapters.mockResolvedValue(rows);
    const library = [
      { id: 'm-a', slug: 'a', source: 'src', chapters: 5 },
      { id: 'm-b', slug: 'b', source: 'src', chapters: 3 },
    ];

    expect(await applyPendingImportedChapterStates('anonymous', library)).toBe(1);
    // Asked only about the title with saved state.
    expect(api.getMangaChapters).toHaveBeenCalledTimes(1);
    expect(api.getMangaChapters).toHaveBeenCalledWith('m-b', 'b', 'src', undefined);
    expect(
      api.markPreviousChaptersAsRead.mock.calls[0][1].map((c: { id: string }) => c.id),
    ).toEqual(['key-1', 'key-2']);
    // Applied once.
    expect(await applyPendingImportedChapterStates('anonymous', library)).toBe(0);
  });

  it('leaves a title with no chapters yet for later, without asking for them', async () => {
    saveTachiyomiImportExtras('job-1', 'anonymous', extras);
    await applyTachiyomiImportExtras('job-1', 'anonymous');
    const unsynced = [{ id: 'm-b', slug: 'b', source: 'src', chapters: 0 }];
    expect(await applyPendingImportedChapterStates('anonymous', unsynced)).toBe(0);
    expect(api.getMangaChapters).not.toHaveBeenCalled();

    api.getMangaChapters.mockResolvedValue([record('1', 1)]);
    const synced = [{ ...unsynced[0], chapters: 1 }];
    expect(await applyPendingImportedChapterStates('anonymous', synced)).toBe(1);
  });

  it('keeps the saved state when marking fails, and applies it on the next try', async () => {
    saveTachiyomiImportExtras('job-1', 'anonymous', extras);
    await applyTachiyomiImportExtras('job-1', 'anonymous');
    api.getMangaChapters.mockResolvedValue([record('1', 1)]);
    api.markPreviousChaptersAsRead.mockRejectedValueOnce(new Error('offline'));
    const library = [{ id: 'm-b', slug: 'b', source: 'src', chapters: 1 }];

    expect(await applyPendingImportedChapterStates('anonymous', library)).toBe(0);
    expect(await applyPendingImportedChapterStates('anonymous', library)).toBe(1);
    expect(api.markPreviousChaptersAsRead).toHaveBeenCalledTimes(2);
  });

  it('still applies read state an earlier version saved under its former name', async () => {
    const formerKey = 'projekt-manga-mihon-chapter-state';
    localStorage.setItem(
      formerKey,
      JSON.stringify({
        'anonymous\0src\0b': {
          source: 'src',
          slug: 'b',
          read: [1],
          lastPage: [],
          owner: 'anonymous',
        },
      }),
    );
    api.getMangaChapters.mockResolvedValue([record('1', 1)]);
    const library = [{ id: 'm-b', slug: 'b', source: 'src', chapters: 1 }];

    expect(await applyPendingImportedChapterStates('anonymous', library)).toBe(1);
    // Moved to the new name as it was read, then dropped once applied.
    expect(localStorage.getItem(formerKey)).toBeNull();
    expect(localStorage.getItem('projekt-manga-tachiyomi-chapter-state')).toBeNull();
  });
});

describe('titles kept without a source', () => {
  it('are recognised under the current and the former prefix', () => {
    expect(sourceNameOfUnmatched('tachiyomi:Gone Source')).toBe('Gone Source');
    expect(sourceNameOfUnmatched('mihon:Gone Source')).toBe('Gone Source');
    expect(sourceNameOfUnmatched('asura-scans')).toBeNull();
  });
});
