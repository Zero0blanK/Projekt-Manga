import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  addCategory: vi.fn(),
  deleteCategory: vi.fn(),
  importCategories: vi.fn(),
  setCategoryMembership: vi.fn(),
  updateCategory: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  ...api,
}));
vi.mock('@/lib/report-error', () => ({ reportError: vi.fn() }));

import { actions, getAppState } from '@/lib/app-store';
import { applyServerCategories, showCachedCategories } from '@/lib/category-sync';
import { queryClient, queryKeys } from '@/lib/query-client';
import { reportError } from '@/lib/report-error';

const saved = [{ id: 'c1', name: 'Favourites', manga_ids: ['m1'] }];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(reportError).mockClear();
  // The server's list, as the categories query last answered it.
  queryClient.setQueryData([...queryKeys.categories, null], saved);
  showCachedCategories(null);
  applyServerCategories(null, saved);
});

describe('a category change the server refuses', () => {
  it('says so, and takes the unsaved category back off the screen', async () => {
    api.addCategory.mockRejectedValueOnce(new Error('Injected server failure'));

    actions.addCategory('Not saved');
    expect(getAppState().customCategories).toContain('Not saved');

    await vi.waitFor(() => expect(reportError).toHaveBeenCalled());
    await vi.waitFor(() => expect(getAppState().customCategories).toEqual(['Favourites']));
    expect(getAppState().categoryMembers).toEqual({ Favourites: ['m1'] });
  });

  it('keeps a category the server accepted', async () => {
    api.addCategory.mockResolvedValueOnce({ id: 'c2', name: 'Saved' });
    actions.addCategory('Saved');
    await new Promise((r) => setTimeout(r, 20));
    expect(getAppState().customCategories).toContain('Saved');
    expect(reportError).not.toHaveBeenCalled();
  });
});
