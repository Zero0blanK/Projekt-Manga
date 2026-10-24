import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const queryKeys = {
  mangaLibrary: ['manga-library'],
  libraryState: ['library-state'],
  session: ['session'],
};
const getReplaceRestore = vi.fn();
const getCurrentUser = vi.fn();

vi.mock('@projekt-manga/api-client', () => ({
  ApiError: class extends Error {},
  getReplaceRestore: (...args: unknown[]) => getReplaceRestore(...args),
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  cancelReplaceRestore: vi.fn(),
  hasLocalDataBridge: () => false,
  localInvoke: vi.fn(),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/app-store', () => ({ setState: vi.fn() }));
vi.mock('@/lib/query-client', () => ({ queryClient, queryKeys }));

const {
  acknowledgeUnknownRestoreStatus,
  savePendingRestore,
  getPendingRestore,
  checkPendingRestore,
} = await import('@/lib/restore-job');

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  getReplaceRestore.mockResolvedValue({ state: 'succeeded', progress: null, result: null });
  getCurrentUser.mockResolvedValue({ user: null });
});

afterEach(() => {
  queryClient.clear();
  onlineManager.setOnline(true);
});

describe('restore refresh with the real query cache', () => {
  it('retains unknown-result acknowledgement when another tab changed the server session', async () => {
    queryClient.setQueryData(queryKeys.session, null);
    getCurrentUser.mockResolvedValue({ user: { id: 'another-account' } });
    savePendingRestore({
      id: 'job',
      owner: 'anonymous',
      settings: {},
      skippedDownloads: 0,
      startedAt: Date.now(),
      statusUnknown: true,
    });

    await expect(acknowledgeUnknownRestoreStatus()).rejects.toThrow('account that started');
    expect(getPendingRestore()?.id).toBe('job');
    expect(queryClient.getQueryData(queryKeys.session)).toEqual({ id: 'another-account' });
  });
  it('retains unknown-result acknowledgement when the account changes during refresh', async () => {
    queryClient.setQueryData(queryKeys.session, null);
    let changedAccount = false;
    await queryClient.fetchQuery({
      queryKey: queryKeys.mangaLibrary,
      queryFn: async () => {
        if (changedAccount) queryClient.setQueryData(queryKeys.session, { id: 'another-account' });
        return [];
      },
    });
    changedAccount = true;
    savePendingRestore({
      id: 'job',
      owner: 'anonymous',
      settings: {},
      skippedDownloads: 0,
      startedAt: Date.now(),
      statusUnknown: true,
    });
    await expect(acknowledgeUnknownRestoreStatus()).rejects.toThrow('account that started');
    expect(getPendingRestore()?.id).toBe('job');
  });
  it.each(['succeeded', 'unknown'] as const)(
    'retains a %s blocker through required refresh failure and releases it after retry',
    async (state) => {
      const fetchLibrary = vi.fn().mockResolvedValue(['old title']);
      await queryClient.fetchQuery({ queryKey: queryKeys.mangaLibrary, queryFn: fetchLibrary });
      fetchLibrary.mockRejectedValueOnce(new Error('library unavailable'));
      savePendingRestore({
        id: 'job',
        owner: 'anonymous',
        settings: {},
        skippedDownloads: 0,
        startedAt: Date.now(),
        statusUnknown: state === 'unknown',
      });
      const finish = () =>
        state === 'unknown' ? acknowledgeUnknownRestoreStatus() : checkPendingRestore('anonymous');

      await expect(finish()).rejects.toThrow('library unavailable');
      expect(getPendingRestore()?.id).toBe('job');
      expect(queryClient.getQueryData(queryKeys.mangaLibrary)).toEqual(['old title']);

      fetchLibrary.mockResolvedValue(['restored title']);
      await finish();
      expect(queryClient.getQueryData(queryKeys.mangaLibrary)).toEqual(['restored title']);
      expect(getPendingRestore()).toBeNull();
    },
  );

  it('keeps the blocker if the query library pauses a refresh while offline', async () => {
    await queryClient.fetchQuery({ queryKey: queryKeys.mangaLibrary, queryFn: async () => [] });
    onlineManager.setOnline(false);
    savePendingRestore({
      id: 'job',
      owner: 'anonymous',
      settings: {},
      skippedDownloads: 0,
      startedAt: Date.now(),
    });
    await expect(checkPendingRestore('anonymous')).rejects.toThrow('could not be refreshed');
    expect(getPendingRestore()?.id).toBe('job');
  });

  it('does not require an unrelated source query to recover', async () => {
    const sourceQuery = vi.fn().mockResolvedValue(['source title']);
    await queryClient.fetchQuery({ queryKey: ['source-browse'], queryFn: sourceQuery });
    sourceQuery.mockRejectedValue(new Error('source unavailable'));
    await queryClient.fetchQuery({ queryKey: queryKeys.mangaLibrary, queryFn: async () => [] });
    savePendingRestore({
      id: 'job',
      owner: 'anonymous',
      settings: {},
      skippedDownloads: 0,
      startedAt: Date.now(),
    });

    await checkPendingRestore('anonymous');
    expect(getPendingRestore()).toBeNull();
    expect(sourceQuery).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(['source-browse'])?.isInvalidated).toBe(true);
  });
});
