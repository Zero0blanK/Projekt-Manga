import { beforeEach, describe, expect, it, vi } from 'vitest';

const getReplaceRestore = vi.fn();
const cancelReplaceRestore = vi.fn();
const localInvoke = vi.fn();
const toast = vi.fn();
const setState = vi.fn();
const invalidateQueries = vi.fn().mockResolvedValue(undefined);
const setProgressWriteHold = vi.fn();

class FakeApiError extends Error {
  constructor(public status: number) {
    super('Not found');
  }
}

vi.mock('@projekt-manga/api-client', () => ({
  ApiError: FakeApiError,
  getReplaceRestore: (...args: unknown[]) => getReplaceRestore(...args),
  getCurrentUser: async () => ({ user: { id: 'account-1' } }),
  cancelReplaceRestore: (...args: unknown[]) => cancelReplaceRestore(...args),
  hasLocalDataBridge: () => true,
  localInvoke: (...args: unknown[]) => localInvoke(...args),
  setProgressWriteHold: (...args: unknown[]) => setProgressWriteHold(...args),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: (...args: unknown[]) => toast(...args) }));
vi.mock('@/lib/app-store', () => ({ setState: (...args: unknown[]) => setState(...args) }));
vi.mock('@/lib/query-client', () => ({
  queryClient: {
    invalidateQueries: (...args: unknown[]) => invalidateQueries(...args),
    getQueryCache: () => ({ findAll: () => [] }),
    getQueryData: () => undefined,
    setQueryData: vi.fn(),
  },
  queryKeys: { mangaLibrary: ['manga-library'], libraryState: ['library-state'] },
}));

const {
  acknowledgeUnknownRestoreStatus,
  savePendingRestore,
  getPendingRestore,
  checkPendingRestore,
  cancelPendingRestore,
  discardTrackedRestore,
  isRestoreRunning,
  markRestoreAccepted,
} = await import('@/lib/restore-job');
// Installed once at import; captured before beforeEach clears the mock.
const installedHold = setProgressWriteHold.mock.calls[0]?.[0] as () => Promise<void> | null;
const pending = {
  id: 'restore-id',
  owner: 'account-1',
  settings: { theme: 'dark' },
  skippedDownloads: 2,
  startedAt: 1,
};

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  vi.clearAllMocks();
  localInvoke.mockResolvedValue(null);
});

describe('restore job recovery', () => {
  it('does not apply an old account completion after reconciliation is interrupted', async () => {
    savePendingRestore(pending);
    const controller = new AbortController();
    getReplaceRestore.mockResolvedValue({ state: 'succeeded', progress: null, result: null });
    localInvoke.mockImplementationOnce(async () => controller.abort());

    await expect(checkPendingRestore(pending.owner, controller.signal)).rejects.toThrow();
    expect(getPendingRestore()?.id).toBe(pending.id);
    expect(setState).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('does not release an old account blocker after refresh is interrupted', async () => {
    savePendingRestore(pending);
    const controller = new AbortController();
    getReplaceRestore.mockResolvedValue({ state: 'succeeded', progress: null, result: null });
    invalidateQueries.mockImplementationOnce(async () => controller.abort());

    await expect(checkPendingRestore(pending.owner, controller.signal)).rejects.toThrow();
    expect(getPendingRestore()?.id).toBe(pending.id);
    expect(toast).not.toHaveBeenCalled();
  });

  it('persists reported row progress for the blocking screen and other tabs', async () => {
    savePendingRestore(pending);
    getReplaceRestore.mockResolvedValue({
      id: pending.id,
      state: 'running',
      result: null,
      progress: { phase: 'Restoring chapters', completed: 4, total: 10 },
    });
    expect(await checkPendingRestore(pending.owner)).toBe('waiting');
    expect(getPendingRestore()?.progress).toEqual({
      phase: 'Restoring chapters',
      completed: 4,
      total: 10,
    });
  });

  it('retains the blocking state when queued cancellation succeeds', async () => {
    savePendingRestore(pending);
    cancelReplaceRestore.mockResolvedValue({
      id: pending.id,
      state: 'cancelled',
      result: null,
      progress: null,
    });
    expect(await cancelPendingRestore()).toBe('cancelled');
    expect(getPendingRestore()).toMatchObject({ ...pending, cancelled: true });
  });

  it('does not overwrite a job being tracked by another tab', () => {
    savePendingRestore(pending);
    expect(() => savePendingRestore({ ...pending, id: 'second' })).toThrow(/already being tracked/);
    expect(getPendingRestore()?.id).toBe(pending.id);
  });

  it('keeps another account from polling or applying a pending restore', async () => {
    savePendingRestore(pending);
    expect(await checkPendingRestore('account-2')).toBe('idle');
    expect(getReplaceRestore).not.toHaveBeenCalled();
    expect(getPendingRestore()).toMatchObject(pending);
  });

  it('reconciles desktop before applying preferences and clearing the job', async () => {
    savePendingRestore(pending);
    getReplaceRestore.mockResolvedValue({
      id: pending.id,
      state: 'succeeded',
      result: { restoredManga: 1, restoredProgress: 2, restoredHistory: 3 },
      progress: null,
    });
    expect(await checkPendingRestore(pending.owner)).toBe('finished');
    expect(localInvoke).toHaveBeenCalledWith('sync', 'reconcileRestore', {
      userId: pending.owner,
      mode: 'replace',
      startedAt: 1,
    });
    expect(setState).toHaveBeenCalled();
    expect(getPendingRestore()).toBeNull();
    expect(toast).toHaveBeenCalled();
  });

  it('retains the job when local reconciliation fails so a later poll can retry', async () => {
    savePendingRestore(pending);
    getReplaceRestore.mockResolvedValue({
      id: pending.id,
      state: 'succeeded',
      result: null,
      progress: null,
    });
    localInvoke.mockRejectedValue(new Error('offline'));
    await expect(checkPendingRestore(pending.owner)).rejects.toThrow('offline');
    expect(getPendingRestore()).toMatchObject(pending);
    expect(setState).not.toHaveBeenCalled();
  });

  it('does not treat an unknown server state as a successful restore', async () => {
    savePendingRestore(pending);
    getReplaceRestore.mockResolvedValue({
      id: pending.id,
      state: 'unknown',
      result: null,
      progress: null,
    });
    await expect(checkPendingRestore(pending.owner)).rejects.toThrow(/Unexpected restore status/);
    expect(getPendingRestore()).toMatchObject(pending);
    expect(setState).not.toHaveBeenCalled();
  });

  it('keeps the library blocked when a durable job is missing and only clears after acknowledgement', async () => {
    const expired = { ...pending, acceptedAt: Date.now() - 121_000 };
    savePendingRestore(expired);
    getReplaceRestore.mockRejectedValue(new FakeApiError(404));

    expect(await checkPendingRestore(pending.owner)).toBe('unknown');
    expect(getPendingRestore()).toMatchObject({ ...expired, statusUnknown: true });
    expect(localInvoke).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();

    await acknowledgeUnknownRestoreStatus();

    expect(localInvoke).toHaveBeenCalledWith('sync', 'reconcileRestore', {
      userId: pending.owner,
      mode: 'replace',
      startedAt: 1,
    });
    expect(invalidateQueries).toHaveBeenCalled();
    expect(getPendingRestore()).toBeNull();
    expect(toast).toHaveBeenCalledWith({
      description:
        'The current server library was refreshed. The previous restore result could not be confirmed; review your data before continuing.',
    });
  });

  it('retains an unknown restore blocker if refreshing current server data fails', async () => {
    savePendingRestore({ ...pending, statusUnknown: true });
    localInvoke.mockRejectedValue(new Error('offline'));

    await expect(acknowledgeUnknownRestoreStatus()).rejects.toThrow('offline');
    expect(getPendingRestore()).toMatchObject({ ...pending, statusUnknown: true });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('waits longer for a job the server has not yet accepted, then counts from acceptance', async () => {
    getReplaceRestore.mockRejectedValue(new FakeApiError(404));
    // Still uploading five minutes in: a large backup on a slow connection, not a lost job.
    savePendingRestore({ ...pending, startedAt: Date.now() - 5 * 60_000 });
    expect(await checkPendingRestore(pending.owner)).toBe('waiting');

    markRestoreAccepted(pending.id);
    expect(getPendingRestore()?.acceptedAt).toBeGreaterThan(0);
    expect(await checkPendingRestore(pending.owner)).toBe('waiting');

    localStorage.setItem(
      'projekt-manga-pending-restore',
      JSON.stringify({ ...pending, acceptedAt: Date.now() - 121_000 }),
    );
    expect(await checkPendingRestore(pending.owner)).toBe('unknown');
  });

  it('only marks the tracked restore as accepted', () => {
    savePendingRestore(pending);
    markRestoreAccepted('another-restore');
    expect(getPendingRestore()?.acceptedAt).toBeUndefined();
  });

  it('stops tracking a restore it cannot resolve without touching the server', () => {
    savePendingRestore({ ...pending, statusUnknown: true });
    discardTrackedRestore();
    expect(getPendingRestore()).toBeNull();
    expect(cancelReplaceRestore).not.toHaveBeenCalled();
    expect(localInvoke).not.toHaveBeenCalled();
  });

  it('holds progress writes only while a restore is being applied', async () => {
    const hold = installedHold;
    expect(hold).toBeTypeOf('function');
    expect(hold()).toBeNull();

    savePendingRestore(pending);
    expect(isRestoreRunning()).toBe(true);
    const waiting = hold();
    expect(waiting).toBeInstanceOf(Promise);
    let released = false;
    void waiting!.then(() => (released = true));
    await Promise.resolve();
    expect(released).toBe(false);

    localStorage.setItem(
      'projekt-manga-pending-restore',
      JSON.stringify({ ...pending, failed: true }),
    );
    window.dispatchEvent(new Event('projekt-manga-restore-finished'));
    await waiting;
    expect(released).toBe(true);
    expect(isRestoreRunning()).toBe(false);
    expect(hold()).toBeNull();
  });
});
