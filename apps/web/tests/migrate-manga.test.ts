import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMigrateManga = vi.fn();
vi.mock('@projekt-manga/api-client', () => ({
  migrateManga: (...a: unknown[]) => apiMigrateManga(...a),
}));

const toggleCategoryMember = vi.fn();
let appState = { categoryMembers: {} as Record<string, string[]> };

vi.mock('@/lib/app-store', () => ({
  actions: { toggleCategoryMember: (...a: unknown[]) => toggleCategoryMember(...a) },
  getAppState: () => appState,
}));

const { migrateManga, describeMigration } = await import('@/lib/migrate-manga');

const plan = {
  from: { mangaId: 'old-1', slug: 'old-slug', title: 'Old Source' },
  to: { mangaId: 'new-1', slug: 'new-slug', title: 'New Source' },
  removeOld: true,
};

function summary(patch: Record<string, unknown> = {}) {
  return {
    progress: 0,
    chapters_marked: 0,
    categories_moved: 0,
    history_moved: 0,
    state_copied: false,
    old_entry_removed: true,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  appState = { categoryMembers: {} };
  apiMigrateManga.mockResolvedValue(summary());
});

describe('migrateManga', () => {
  it('delegates the whole move to the server in one call', async () => {
    await migrateManga(plan);

    // The whole move is a single server transaction, not several requests.
    expect(apiMigrateManga).toHaveBeenCalledTimes(1);
    expect(apiMigrateManga).toHaveBeenCalledWith('old-1', 'new-1', {
      remove_old: true,
      move_history: true,
    });
  });

  it('passes the caller’s choices through rather than assuming them', async () => {
    await migrateManga({ ...plan, removeOld: false, moveHistory: false });

    expect(apiMigrateManga).toHaveBeenCalledWith('old-1', 'new-1', {
      remove_old: false,
      move_history: false,
    });
  });

  it('mirrors the category move into local state, which the server does not own', async () => {
    appState = { categoryMembers: { Favorites: ['old-1', 'other'], Unrelated: ['other'] } };

    const result = await migrateManga(plan);

    expect(result.local_categories_moved).toBe(1);
    expect(toggleCategoryMember).toHaveBeenCalledWith('Favorites', 'new-1');
    expect(toggleCategoryMember).toHaveBeenCalledWith('Favorites', 'old-1');
    expect(toggleCategoryMember).not.toHaveBeenCalledWith('Unrelated', expect.anything());
  });

  it('does not add the new entry to a category it is already in', async () => {
    appState = { categoryMembers: { Favorites: ['old-1', 'new-1'] } };

    await migrateManga(plan);

    // Only the removal of the old id — toggling the new one would take it back out.
    expect(toggleCategoryMember).toHaveBeenCalledTimes(1);
    expect(toggleCategoryMember).toHaveBeenCalledWith('Favorites', 'old-1');
  });

  it('surfaces a failed migration instead of reporting partial success', async () => {
    apiMigrateManga.mockRejectedValue(new Error('offline'));

    await expect(migrateManga(plan)).rejects.toThrow('offline');
    // The server transaction rolled back, so local state must not be moved either.
    expect(toggleCategoryMember).not.toHaveBeenCalled();
  });

  it('returns the server summary alongside the local count', async () => {
    apiMigrateManga.mockResolvedValue(
      summary({ progress: 12, chapters_marked: 12, history_moved: 4, state_copied: true }),
    );

    const result = await migrateManga(plan);

    expect(result).toMatchObject({ progress: 12, chapters_marked: 12, history_moved: 4 });
  });
});

describe('describeMigration', () => {
  it('names what actually transferred', async () => {
    const text = describeMigration(
      {
        ...summary({
          chapters_marked: 12,
          state_copied: true,
          categories_moved: 2,
          history_moved: 4,
        }),
        local_categories_moved: 2,
      },
      'New Source',
    );

    expect(text).toContain('12 chapters read');
    expect(text).toContain('shelf and rating');
    expect(text).toContain('2 categories');
    expect(text).toContain('4 history entries');
  });

  it('stays plain when there was nothing to carry over', async () => {
    const text = describeMigration({ ...summary(), local_categories_moved: 0 }, 'New Source');

    expect(text).toBe('Migrated to "New Source".');
  });

  it('does not double-count a category moved on both sides', async () => {
    const text = describeMigration(
      { ...summary({ categories_moved: 1 }), local_categories_moved: 1 },
      'New Source',
    );

    // The server row and the local mirror are the same category, not two.
    expect(text).toContain('1 category');
    expect(text).not.toContain('2 categor');
  });
});
