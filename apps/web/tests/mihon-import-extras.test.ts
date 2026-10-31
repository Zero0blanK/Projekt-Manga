import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MangaChapterRecord } from '@projekt-manga/api-client';

const api = vi.hoisted(() => ({
  getManga: vi.fn(),
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
  applyMihonChapterState,
  applyMihonImportExtras,
  clearMihonImportExtras,
  saveMihonImportExtras,
} from '@/lib/mihon-backup/extras';

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

describe('Mihon import extras', () => {
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
    saveMihonImportExtras('job-1', 'anonymous', extras);
    expect(await applyMihonImportExtras('job-2', 'anonymous')).toBeNull();
    expect(await applyMihonImportExtras('job-1', 'someone-else')).toBeNull();

    const applied = await applyMihonImportExtras('job-1', 'anonymous');
    expect(applied).toEqual({ categories: 1, trackerLinks: 1, skippedTrackerLinks: 1 });
    expect(getAppState().customCategories).toContain('Weekly');
    expect(getAppState().categoryMembers.Weekly).toEqual(['m-a']);
    expect(api.linkMangaToTracker).toHaveBeenCalledWith('m-a', {
      tracker: 'ANILIST',
      tracker_media_id: '1',
    });
    expect(await applyMihonImportExtras('job-1', 'anonymous')).toBeNull();
  });

  it('reuses an existing category of the same name and is idempotent on retry', async () => {
    const { setState } = await import('@/lib/app-store');
    setState({ customCategories: ['weekly'], categoryMembers: { weekly: ['m-old'] } });
    saveMihonImportExtras('job-1', 'anonymous', extras);
    await applyMihonImportExtras('job-1', 'anonymous');
    // Applied a second time, nothing is duplicated.
    saveMihonImportExtras('job-1', 'anonymous', extras);
    await applyMihonImportExtras('job-1', 'anonymous');
    expect(getAppState().customCategories.filter((c) => c.toLowerCase() === 'weekly')).toEqual([
      'weekly',
    ]);
    expect(getAppState().categoryMembers.weekly).toEqual(['m-old', 'm-a']);
  });

  it('is dropped when the restore fails', async () => {
    saveMihonImportExtras('job-1', 'anonymous', extras);
    clearMihonImportExtras('job-1');
    expect(await applyMihonImportExtras('job-1', 'anonymous')).toBeNull();
  });

  it('marks chapters by number after the first sync, once', async () => {
    saveMihonImportExtras('job-1', 'anonymous', extras);
    await applyMihonImportExtras('job-1', 'anonymous');
    const manga = { id: 'm-b', slug: 'b', source: 'src' };

    // Not synced yet: the state waits.
    expect(await applyMihonChapterState('anonymous', manga, [])).toBeNull();

    const rows = [record('1', 1), record('2', 2), record('3', 3), record('4', 4)];
    const marked = await applyMihonChapterState('anonymous', manga, rows);
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
    expect(await applyMihonChapterState('anonymous', manga, rows)).toBeNull();
  });
});
