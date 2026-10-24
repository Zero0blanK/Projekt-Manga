import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSourceMangaUpdates = vi.fn();
const triggerCacheSync = vi.fn();
const invalidateRecentChapters = vi.fn();

vi.mock('@projekt-manga/api-client', () => ({
  fetchSourceMangaUpdates: (...args: unknown[]) => fetchSourceMangaUpdates(...args),
  triggerCacheSync: (...args: unknown[]) => triggerCacheSync(...args),
}));
vi.mock('@/lib/notifications-store', () => ({
  invalidateRecentChapters: () => invalidateRecentChapters(),
}));

const { runLibraryUpdate, isLibraryUpdateRunning, cancelLibraryUpdate } =
  await import('@/lib/run-library-update');

const manga = [
  { id: 'one', source: 'source-a', slug: 'one', title: 'One' },
  { id: 'two', source: 'source-b', slug: 'two', title: 'Two' },
] as never[];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runLibraryUpdate', () => {
  it('continues after one source fails and refreshes the notification feed for found chapters', async () => {
    fetchSourceMangaUpdates
      .mockResolvedValueOnce({ newChapters: 2 })
      .mockRejectedValueOnce(new Error('source unavailable'));

    await expect(runLibraryUpdate(manga, { refreshCovers: false })).resolves.toEqual({
      found: 2,
      failed: ['Two'],
      foundBySource: { 'source-a': 2 },
      failedBySource: { 'source-b': 1 },
      cancelled: false,
    });
    expect(fetchSourceMangaUpdates).toHaveBeenNthCalledWith(
      1,
      'source-a',
      'one',
      'one',
      expect.any(AbortSignal),
    );
    expect(fetchSourceMangaUpdates).toHaveBeenNthCalledWith(
      2,
      'source-b',
      'two',
      'two',
      expect.any(AbortSignal),
    );
    // Once for the successful title and once for the completed pass.
    expect(invalidateRecentChapters).toHaveBeenCalledTimes(2);
  });

  it('refreshes covers only after that title has been checked', async () => {
    fetchSourceMangaUpdates.mockResolvedValue({ newChapters: 0 });
    triggerCacheSync.mockResolvedValue(undefined);

    await runLibraryUpdate(manga, { refreshCovers: true });

    expect(triggerCacheSync).toHaveBeenNthCalledWith(1, 'one', undefined, expect.any(AbortSignal));
    expect(triggerCacheSync).toHaveBeenNthCalledWith(2, 'two', undefined, expect.any(AbortSignal));
  });

  it('reports a logged source failure even when the endpoint returns HTTP 200', async () => {
    fetchSourceMangaUpdates
      .mockResolvedValueOnce({ newChapters: 0, failed: true })
      .mockResolvedValueOnce({ newChapters: 1, failed: false });

    await expect(runLibraryUpdate(manga, { refreshCovers: true })).resolves.toEqual({
      found: 1,
      failed: ['One'],
      foundBySource: { 'source-b': 1 },
      failedBySource: { 'source-a': 1 },
      cancelled: false,
    });
    expect(triggerCacheSync).not.toHaveBeenCalledWith('one');
  });

  it('counts chapters already saved before a later step in the check failed', async () => {
    fetchSourceMangaUpdates
      .mockResolvedValueOnce({ newChapters: 2, failed: true })
      .mockResolvedValueOnce({ newChapters: 0, failed: false });

    await expect(runLibraryUpdate(manga, { refreshCovers: false })).resolves.toEqual({
      found: 2,
      failed: ['One'],
      foundBySource: { 'source-a': 2 },
      failedBySource: { 'source-a': 1 },
      cancelled: false,
    });
    expect(invalidateRecentChapters).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight source pass between concurrent callers', async () => {
    let release: (value: { newChapters: number; failed: boolean }) => void = () => {};
    fetchSourceMangaUpdates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    fetchSourceMangaUpdates.mockResolvedValue({ newChapters: 0, failed: false });

    const first = runLibraryUpdate(manga, { refreshCovers: false });
    const second = runLibraryUpdate(manga, { refreshCovers: false });
    expect(isLibraryUpdateRunning()).toBe(true);
    expect(fetchSourceMangaUpdates).toHaveBeenCalledTimes(1);

    release({ newChapters: 1, failed: false });
    await expect(first).resolves.toEqual({
      found: 1,
      failed: [],
      foundBySource: { 'source-a': 1 },
      failedBySource: {},
      cancelled: false,
    });
    await expect(second).resolves.toEqual({
      found: 1,
      failed: [],
      foundBySource: { 'source-a': 1 },
      failedBySource: {},
      cancelled: false,
    });
    expect(fetchSourceMangaUpdates).toHaveBeenCalledTimes(2);
    expect(isLibraryUpdateRunning()).toBe(false);
  });

  it('aborts the active request and stops before starting another title', async () => {
    let requestSignal: AbortSignal | undefined;
    fetchSourceMangaUpdates.mockImplementationOnce(
      (_source: string, _slug: string, _id: string, signal: AbortSignal) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      },
    );

    const run = runLibraryUpdate(manga, { refreshCovers: false });
    cancelLibraryUpdate();

    await expect(run).resolves.toMatchObject({ cancelled: true, failed: [] });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchSourceMangaUpdates).toHaveBeenCalledTimes(1);
    expect(isLibraryUpdateRunning()).toBe(false);
  });

  it('notifies the scheduler when each source is first dispatched', async () => {
    fetchSourceMangaUpdates.mockResolvedValue({ newChapters: 0, failed: false });
    const onSourceStart = vi.fn();

    await runLibraryUpdate(manga, { refreshCovers: false, onSourceStart });

    expect(onSourceStart.mock.calls).toEqual([['source-a'], ['source-b']]);
  });
});
