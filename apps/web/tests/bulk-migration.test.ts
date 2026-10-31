import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';

const { toast, searchSourceMangaPage, migrateTitle } = vi.hoisted(() => ({
  toast: vi.fn(() => ({ id: '1', dismiss: vi.fn(), update: vi.fn() })),
  searchSourceMangaPage: vi.fn(),
  migrateTitle: vi.fn(),
}));
vi.mock('@/hooks/use-toast', () => ({ toast }));
vi.mock('@projekt-manga/api-client', () => ({
  searchSourceMangaPage,
  getSourceMangaDetails: vi.fn(async () => ({ title: 'X', chapters: [] })),
  getMangaDetailsById: vi.fn(async () => ({ chapters: [] })),
}));
vi.mock('@/lib/source-search-queue', () => ({
  scheduleSourceSearch: (_signal: AbortSignal, request: () => Promise<unknown>) => request(),
}));
vi.mock('@/lib/migrate-title', () => ({
  migrateTitle,
  newMigrationCheckpoint: () => ({}),
}));
vi.mock('@/components/migrate/bulk-migration-progress', () => ({
  BulkMigrationProgress: () => null,
}));

const { bulkMigration, bulkProgress, useBulkMigration } = await import('@/lib/bulk-migration');
const { renderHook } = await import('@testing-library/react');

const title = (id: string, name: string) =>
  ({ id, title: name, source: 'old', slug: id, inLibrary: true }) as Manga;

describe('bulk migration', () => {
  beforeEach(() => {
    bulkMigration.reset();
    vi.clearAllMocks();
    searchSourceMangaPage.mockImplementation(async (sourceId: string, { query }) => ({
      items:
        sourceId === 'b' && query === 'Found'
          ? [{ id: 'found', slug: 'found', title: 'Found', source: 'b', thumbnail_url: '' }]
          : [],
      hasMore: false,
    }));
  });

  it('keeps matches in shared state, with progress, and lets missing ones be chosen or skipped', async () => {
    bulkMigration.chooseSource('old');
    await bulkMigration.findMatches([title('1', 'Found'), title('2', 'Missing')], ['a', 'b']);
    // Read through a fresh hook, as a page opened again later would.
    const { result } = renderHook(() => useBulkMigration());
    expect(result.current.stage).toBe('matches');
    expect(result.current.rows.map((row) => [row.search, row.match?.sourceId ?? null])).toEqual([
      ['found', 'b'],
      ['missing', null],
    ]);
    expect(bulkProgress(result.current)).toMatchObject({ done: 2, total: 2, active: false });
    // The searches showed a progress toast.
    expect(toast).toHaveBeenCalled();

    bulkMigration.chooseMatch('2', {
      sourceId: 'a',
      slug: 'picked',
      title: 'Picked',
      thumbnailUrl: '',
      score: 1,
    });
    bulkMigration.setSkipped('1', true);
    const { result: again } = renderHook(() => useBulkMigration());
    expect(again.current.rows[1]).toMatchObject({ manual: true, match: { slug: 'picked' } });
    expect(again.current.rows[0].skipped).toBe(true);
  });

  it('migrates only the included titles and reports the outcome', async () => {
    migrateTitle.mockResolvedValue({ state: 'done', targetId: 'new' });
    bulkMigration.chooseSource('old');
    await bulkMigration.findMatches([title('1', 'Found'), title('2', 'Missing')], ['b']);
    const refresh = vi.fn();
    await bulkMigration.migrate(
      { read: false, shelf: true, bookmark: true, categories: true },
      { library: [], shelf: {}, bookmarks: [], refresh },
    );
    expect(migrateTitle).toHaveBeenCalledTimes(1);
    expect(migrateTitle.mock.calls[0][0]).toMatchObject({ originalId: '1', sourceId: 'b' });
    const { result } = renderHook(() => useBulkMigration());
    expect(result.current.stage).toBe('finished');
    expect(result.current.rows[0].run).toEqual({ state: 'done', targetId: 'new' });
    expect(refresh).toHaveBeenCalled();
  });
});
