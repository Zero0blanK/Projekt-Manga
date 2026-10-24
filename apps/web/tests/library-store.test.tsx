import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const updateLibraryState = vi.fn();
const getLibraryState = vi.fn();
const getManga = vi.fn();
const getSourceMangaPage = vi.fn();
const searchSourceMangaPage = vi.fn();
const getSourceCapabilities = vi.fn();

vi.mock('@projekt-manga/api-client', () => ({
  ApiError: class ApiError extends Error {},
  getManga: (...args: unknown[]) => getManga(...args),
  getLibraryState: (...args: unknown[]) => getLibraryState(...args),
  updateLibraryState: (...args: unknown[]) => updateLibraryState(...args),
  getSources: vi.fn().mockResolvedValue([]),
  getSourceMangaPage: (...args: unknown[]) => getSourceMangaPage(...args),
  searchSourceMangaPage: (...args: unknown[]) => searchSourceMangaPage(...args),
  getSourceFilters: vi.fn().mockResolvedValue([]),
  getSourceCapabilities: (...args: unknown[]) => getSourceCapabilities(...args),
  buildImageProxyUrl: (url: string) => `http://localhost:4000/api/source/image-proxy?url=${url}`,
}));

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { useLibraryState, useSourceBrowsePaged, useSourceCapabilities, libraryActions } =
  await import('@/lib/library-store');
const { queryClient, invalidateSourceDependentQueries } = await import('@/lib/query-client');

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function row(manga_id: string, patch: Record<string, unknown> = {}) {
  return {
    manga_id,
    is_bookmarked: false,
    shelf_status: null,
    score: null,
    notification_read: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

beforeEach(() => {
  queryClient.clear();
  vi.clearAllMocks();
  getLibraryState.mockResolvedValue([]);
  getManga.mockResolvedValue([]);
  getSourceMangaPage.mockResolvedValue({ items: [], hasMore: false });
  searchSourceMangaPage.mockResolvedValue({ items: [], hasMore: false });
});

afterEach(() => {
  queryClient.clear();
});

/**
 * The optimistic-update contract is the part of this store that can lose a reader's data
 * if it regresses: a failed write that isn't rolled back leaves the UI showing a bookmark
 * or a rating the server never accepted, which then vanishes on the next reload and looks
 * like the app threw the change away for no reason.
 */
describe('libraryActions optimistic updates', () => {
  it('does not restore an old profile row into the new account after a failed write', async () => {
    queryClient.setQueryData(['session'], { id: 'account-a' });
    queryClient.setQueryData(['library-state'], [row('m-1', { is_bookmarked: true })]);
    let rejectWrite!: (error: Error) => void;
    updateLibraryState.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectWrite = reject;
      }),
    );
    const write = libraryActions.setBookmark('m-1', false);
    const rejected = expect(write).rejects.toThrow('Interrupted');
    queryClient.setQueryData(['session'], { id: 'account-b' });
    queryClient.setQueryData(['library-state'], [row('m-2')]);
    rejectWrite(new Error('Interrupted'));
    await rejected;
    expect(queryClient.getQueryData(['library-state'])).toEqual([row('m-2')]);
  });
  it('applies a bookmark locally before the server has answered', async () => {
    getLibraryState.mockResolvedValue([row('m-1')]);
    let resolveWrite: () => void = () => {};
    updateLibraryState.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
    );

    const { result } = renderHook(() => useLibraryState(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pending!: Promise<void>;
    act(() => {
      pending = libraryActions.toggleBookmark('m-1');
    });

    // Visible immediately, with the write still in flight — that's the whole point.
    await waitFor(() => expect(result.current.bookmarks).toEqual(['m-1']));

    await act(async () => {
      resolveWrite();
      await pending;
    });
    expect(result.current.bookmarks).toEqual(['m-1']);
  });

  it('rolls the change back and rejects when the write fails', async () => {
    getLibraryState.mockResolvedValue([row('m-1', { is_bookmarked: true })]);
    updateLibraryState.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useLibraryState(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual(['m-1']));

    await act(async () => {
      await expect(libraryActions.toggleBookmark('m-1')).rejects.toThrow('offline');
    });

    // Back to bookmarked — the un-bookmark never reached the server.
    expect(result.current.bookmarks).toEqual(['m-1']);
  });

  it('rolls back only the failed title, never a concurrent change to another', async () => {
    getLibraryState.mockResolvedValue([row('m-1'), row('m-2')]);
    updateLibraryState.mockImplementation(async (mangaId: string) => {
      if (mangaId === 'm-1') throw new Error('rejected');
    });

    const { result } = renderHook(() => useLibraryState(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await Promise.allSettled([
        libraryActions.toggleBookmark('m-1'),
        libraryActions.toggleBookmark('m-2'),
      ]);
    });

    // m-1's failure must not discard m-2's successful optimistic update.
    await waitFor(() => expect(result.current.bookmarks).toEqual(['m-2']));
  });

  it('removes an invented row entirely when the first write for a title fails', async () => {
    getLibraryState.mockResolvedValue([]); // no row for this manga yet
    updateLibraryState.mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useLibraryState(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(libraryActions.setScore('m-9', 80)).rejects.toThrow('nope');
    });

    await waitFor(() => expect(result.current.score['m-9']).toBeUndefined());
  });

  it('maps shelf status between the app and API vocabularies in both directions', async () => {
    getLibraryState.mockResolvedValue([row('m-1', { shelf_status: 'ON_HOLD' })]);
    updateLibraryState.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLibraryState(), { wrapper });
    await waitFor(() => expect(result.current.shelf['m-1']).toBe('on-hold'));

    await act(async () => {
      await libraryActions.setShelf('m-1', 'plan');
    });

    expect(updateLibraryState).toHaveBeenCalledWith('m-1', { shelf_status: 'PLAN' });
    await waitFor(() => expect(result.current.shelf['m-1']).toBe('plan'));
  });
});

describe('useSourceBrowsePaged', () => {
  it('shares cached capabilities between consumers and refreshes them when extensions change', async () => {
    const caps = {
      latest: true,
      search: true,
      filters: false,
      languageFilter: false,
      urlSearch: false,
      nativePagination: true,
    };
    getSourceCapabilities.mockResolvedValue(caps);
    const { result } = renderHook(
      () => [useSourceCapabilities('source-1'), useSourceCapabilities('source-1')],
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.every((entry) => entry.capabilities?.latest)).toBe(true),
    );
    expect(getSourceCapabilities).toHaveBeenCalledTimes(1);
    getSourceCapabilities.mockResolvedValue({ ...caps, latest: false });
    await act(async () => {
      await invalidateSourceDependentQueries();
    });
    await waitFor(() =>
      expect(result.current.every((entry) => entry.capabilities?.latest === false)).toBe(true),
    );
    expect(getSourceCapabilities).toHaveBeenCalledTimes(2);
  });

  it('keeps a short native page pageable and deduplicates overlap independently of its cursor', async () => {
    const one = { id: 'one', source: 'source-1', title: 'One' };
    const two = { id: 'two', source: 'source-1', title: 'Two' };
    getSourceMangaPage
      .mockResolvedValueOnce({ items: [one, one], hasMore: true, nextCursor: '/page/2/' })
      .mockResolvedValueOnce({ items: [one, two], hasMore: false });
    const { result } = renderHook(() => useSourceBrowsePaged('source-1', 'popular', {}), {
      wrapper,
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(getSourceMangaPage.mock.calls[1][1].cursor).toBe('/page/2/');
    expect(result.current.hasMore).toBe(false);
  });

  it.each(['repeated cursor', 'no new results'])(
    'stops automatic paging after %s and retries the same cursor',
    async (reason) => {
      const one = { id: 'one', source: 'source-1', title: 'One' };
      const two = { id: 'two', source: 'source-1', title: 'Two' };
      getSourceMangaPage
        .mockResolvedValueOnce({ items: [one], hasMore: true, nextCursor: 'p2' })
        .mockResolvedValueOnce({
          items: reason === 'repeated cursor' ? [two] : [one],
          hasMore: true,
          nextCursor: reason === 'repeated cursor' ? 'p2' : 'p3',
        })
        .mockResolvedValueOnce({ items: [two], hasMore: false });
      const { result } = renderHook(() => useSourceBrowsePaged('source-1', 'popular', {}), {
        wrapper,
      });
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.loadMoreError).toBe(true));
      expect(result.current.items).toEqual([one]);
      expect(result.current.nextCursor).toBe('p2');
      act(() => result.current.loadMore());
      expect(getSourceMangaPage).toHaveBeenCalledTimes(2);
      act(() => result.current.retryLoadMore());
      await waitFor(() => expect(result.current.items).toHaveLength(2));
      expect(getSourceMangaPage.mock.calls[2][1].cursor).toBe('p2');
    },
  );

  it('restores a saved opaque cursor without fetching the first page', async () => {
    const initial = {
      items: [{ id: 'saved', source: 'source-1', title: 'Saved' }] as never[],
      hasMore: true,
      nextCursor: 'saved-next',
    };
    const { result } = renderHook(
      () => useSourceBrowsePaged('source-1', 'popular', {}, 20, initial),
      { wrapper },
    );
    await waitFor(() => expect(result.current.nextCursor).toBe('saved-next'));
    expect(getSourceMangaPage).not.toHaveBeenCalled();
    act(() => result.current.loadMore());
    await waitFor(() => expect(getSourceMangaPage).toHaveBeenCalledTimes(1));
    expect(getSourceMangaPage.mock.calls[0][1].cursor).toBe('saved-next');
  });

  it('refetches old pageable snapshots without a cursor instead of deriving one from rendered rows', async () => {
    const initial = {
      items: [{ id: 'saved', source: 'source-1', title: 'Saved' }] as never[],
      hasMore: true,
    };
    const { result } = renderHook(
      () => useSourceBrowsePaged('source-1', 'popular', {}, 20, initial),
      { wrapper },
    );
    await waitFor(() => expect(getSourceMangaPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(getSourceMangaPage.mock.calls[0][1].cursor).toBeUndefined();
  });

  it('aborts and ignores an old page when the source changes', async () => {
    let resolveOld!: (value: unknown) => void;
    getSourceMangaPage
      .mockResolvedValueOnce({
        items: [{ id: 'one', source: 'source-1', title: 'One' }],
        hasMore: true,
        nextCursor: 'old-next',
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        items: [{ id: 'new', source: 'source-2', title: 'New' }],
        hasMore: false,
      });
    const { result, rerender } = renderHook(
      ({ source }) => useSourceBrowsePaged(source, 'popular', {}),
      { initialProps: { source: 'source-1' }, wrapper },
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(getSourceMangaPage).toHaveBeenCalledTimes(2);
    rerender({ source: 'source-2' });
    await waitFor(() => expect(result.current.items[0]?.id).toBe('new'));
    expect(getSourceMangaPage.mock.calls[1][2].aborted).toBe(true);
    await act(async () =>
      resolveOld({ items: [{ id: 'old', source: 'source-1', title: 'Old' }], hasMore: false }),
    );
    expect(result.current.items.map((row) => row.id)).toEqual(['new']);
    expect(getSourceMangaPage.mock.calls[2][1].cursor).toBeUndefined();
  });

  it('requests 20 titles for its first browse page by default', async () => {
    const { result } = renderHook(() => useSourceBrowsePaged('source-1', 'latest', {}), {
      wrapper,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getSourceMangaPage).toHaveBeenCalledWith(
      'source-1',
      {
        category: 'latest',
        filters: {},
        limit: 20,
      },
      expect.any(AbortSignal),
    );
  });

  it('searches the full source catalog with the same 20-item paging', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `result-${index}`,
      source: 'source-1',
      title: `Search result ${index}`,
    }));
    searchSourceMangaPage
      .mockResolvedValueOnce({ items: firstPage, hasMore: true, nextCursor: 'next-page' })
      .mockResolvedValueOnce({ items: [], hasMore: false });
    const { result } = renderHook(
      () => useSourceBrowsePaged('source-1', 'popular', {}, 20, null, '  target  '),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(20));
    expect(getSourceMangaPage).not.toHaveBeenCalled();
    expect(searchSourceMangaPage).toHaveBeenCalledWith(
      'source-1',
      { query: 'target', filters: {}, limit: 20 },
      expect.any(AbortSignal),
    );

    act(() => result.current.loadMore());
    await waitFor(() => expect(searchSourceMangaPage).toHaveBeenCalledTimes(2));
    expect(searchSourceMangaPage).toHaveBeenLastCalledWith(
      'source-1',
      { query: 'target', filters: {}, limit: 20, cursor: 'next-page' },
      expect.any(AbortSignal),
    );
  });

  it('returns to category browsing after clearing a search', async () => {
    const { result, rerender } = renderHook(
      ({ query }) => useSourceBrowsePaged('source-1', 'latest', {}, 20, null, query),
      { initialProps: { query: 'target' }, wrapper },
    );
    await waitFor(() => expect(searchSourceMangaPage).toHaveBeenCalledTimes(1));
    rerender({ query: '' });
    await waitFor(() => expect(getSourceMangaPage).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.itemsQueryIdentity).toBe(
        JSON.stringify(['source-1', 'latest', '{}', '']),
      ),
    );
  });

  it('retries a failed source-wide search without falling back to local results', async () => {
    searchSourceMangaPage
      .mockRejectedValueOnce(new Error('source unavailable'))
      .mockResolvedValueOnce({
        items: [{ id: 'match', title: 'Match', source: 'source-1' }],
        hasMore: false,
      });
    const { result } = renderHook(
      () => useSourceBrowsePaged('source-1', 'popular', {}, 20, null, 'target'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.error).toBeTruthy());
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.items[0]?.id).toBe('match'));
    expect(searchSourceMangaPage).toHaveBeenCalledTimes(2);
    expect(getSourceMangaPage).not.toHaveBeenCalled();
  });
});

describe('markAllNotificationsRead', () => {
  it('settles every title even when some fail, and reports how many did not land', async () => {
    getLibraryState.mockResolvedValue([row('m-1'), row('m-2'), row('m-3')]);
    updateLibraryState.mockImplementation(async (mangaId: string) => {
      if (mangaId === 'm-2') throw new Error('rejected');
    });

    const { result } = renderHook(() => useLibraryState(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(libraryActions.markAllNotificationsRead(['m-1', 'm-2', 'm-3'])).rejects.toThrow(
        /1 of 3/,
      );
    });

    // Promise.all would have abandoned m-3 the moment m-2 rejected.
    expect(updateLibraryState).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(result.current.readNotifications.sort()).toEqual(['m-1', 'm-3']));
  });
});
