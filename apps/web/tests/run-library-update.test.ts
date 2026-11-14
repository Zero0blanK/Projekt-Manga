import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSourceMangaUpdates = vi.fn();
const triggerCacheSync = vi.fn();
const getAllMangaLinks = vi.fn(async (): Promise<unknown[]> => []);
const invalidateRecentChapters = vi.fn();

vi.mock('@projekt-manga/api-client', () => ({
  fetchSourceMangaUpdates: (...args: unknown[]) => fetchSourceMangaUpdates(...args),
  triggerCacheSync: (...args: unknown[]) => triggerCacheSync(...args),
  getAllMangaLinks: (...args: unknown[]) => getAllMangaLinks(...args),
}));
const beforeCheckingSource = vi.fn((): Promise<unknown> | null => null);
const passCheckForUpdate = vi.fn(async () => false);
vi.mock('@/lib/source-check-queue', () => ({
  beforeCheckingSource: (...args: unknown[]) => beforeCheckingSource(...(args as [])),
  passCheckForUpdate: (...args: unknown[]) => passCheckForUpdate(...(args as [])),
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
  it("checks the titles' linked sources after the titles themselves", async () => {
    getAllMangaLinks.mockResolvedValueOnce([
      {
        primary_id: 'one',
        linked: [{ id: 'one-b', source: 'source-c', slug: 'one-elsewhere', title: 'One (C)' }],
      },
    ]);
    fetchSourceMangaUpdates.mockResolvedValue({ newChapters: 0 });
    await runLibraryUpdate(manga, { refreshCovers: false });
    expect(fetchSourceMangaUpdates.mock.calls.map((call) => call[2])).toEqual([
      'one',
      'two',
      'one-b',
    ]);
  });

  it('checks the titles alone when linked sources cannot be read', async () => {
    getAllMangaLinks.mockRejectedValueOnce(new Error('offline'));
    fetchSourceMangaUpdates.mockResolvedValue({ newChapters: 0 });
    await runLibraryUpdate(manga, { refreshCovers: false });
    expect(fetchSourceMangaUpdates).toHaveBeenCalledTimes(2);
  });

  it('continues after one source fails and refreshes the notification feed for found chapters', async () => {
    fetchSourceMangaUpdates
      .mockResolvedValueOnce({ newChapters: 2 })
      .mockRejectedValueOnce(new Error('source unavailable'));

    await expect(runLibraryUpdate(manga, { refreshCovers: false })).resolves.toEqual({
      found: 2,
      failed: ['Two'],
      foundBySource: { 'source-a': 2 },
      foundByManga: { one: 2 },
      foundTitles: expect.any(Object),
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
      foundByManga: { two: 1 },
      foundTitles: expect.any(Object),
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
      foundByManga: { one: 2 },
      foundTitles: expect.any(Object),
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
      foundByManga: { one: 1 },
      foundTitles: expect.any(Object),
      failedBySource: {},
      cancelled: false,
    });
    await expect(second).resolves.toEqual({
      found: 1,
      failed: [],
      foundBySource: { 'source-a': 1 },
      foundByManga: { one: 1 },
      foundTitles: expect.any(Object),
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

  it("waits for a source's queued browser check before checking its titles", async () => {
    let release: () => void = () => {};
    beforeCheckingSource.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    fetchSourceMangaUpdates.mockResolvedValue({ newChapters: 0, failed: false });
    const run = runLibraryUpdate(manga, { refreshCovers: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSourceMangaUpdates).not.toHaveBeenCalled();
    release();
    await run;
    expect(fetchSourceMangaUpdates).toHaveBeenCalledTimes(2);
  });

  it('passes a check met mid-update and tries the title again, instead of leaving it stale', async () => {
    fetchSourceMangaUpdates
      .mockResolvedValueOnce({ newChapters: 0, failed: true, errorCode: 'CHALLENGE_REQUIRED' })
      .mockResolvedValue({ newChapters: 3, failed: false });
    passCheckForUpdate.mockResolvedValueOnce(true);
    const result = await runLibraryUpdate([manga[0]], { refreshCovers: false });
    expect(passCheckForUpdate).toHaveBeenCalledWith('source-a', expect.any(AbortSignal));
    expect(result).toMatchObject({ found: 3, failed: [] });
  });

  it('counts the title as failed when the check could not be passed', async () => {
    fetchSourceMangaUpdates.mockResolvedValue({
      newChapters: 0,
      failed: true,
      errorCode: 'CHALLENGE_REQUIRED',
    });
    const result = await runLibraryUpdate([manga[0]], { refreshCovers: false });
    expect(fetchSourceMangaUpdates).toHaveBeenCalledTimes(1);
    expect(result.failed).toEqual(['One']);
  });

  it('notifies the scheduler when each source is first dispatched', async () => {
    fetchSourceMangaUpdates.mockResolvedValue({ newChapters: 0, failed: false });
    const onSourceStart = vi.fn();

    await runLibraryUpdate(manga, { refreshCovers: false, onSourceStart });

    expect(onSourceStart.mock.calls).toEqual([['source-a'], ['source-b']]);
  });
});
