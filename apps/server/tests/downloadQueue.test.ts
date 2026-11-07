import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DownloadWorker } from '../src/workers/download.worker.js';

/**
 * The scheduler's budget is a number of *free slots*, and it used to spend one of them on
 * every queue entry it looked at rather than every download it started. Entries that cannot
 * run — a paused id (which `addToQueue` will happily re-queue, since it does not filter
 * them) or one still unwinding from a previous run — therefore consumed capacity while
 * starting nothing.
 *
 * That is a starvation bug, not a slow path: when a pass launches nothing, nothing schedules
 * another one. The only re-entry point is the `finally` attached to a launched download, so
 * real work behind those entries waits with every slot free until some unrelated call
 * happens to drive the queue again.
 *
 * These reach into private state deliberately. The alternative is standing up a database, a
 * source and a real HTTP download to observe a scheduling decision, which would test
 * everything except the scheduling decision.
 */
type WorkerInternals = {
  queue: string[];
  pausedDownloads: Set<string>;
  downloadThreads: Map<string, Promise<void>>;
  maxConcurrent: number;
  launchDownload: (id: string) => void;
  processQueue: () => void;
};

function internals(worker: DownloadWorker): WorkerInternals {
  return worker as unknown as WorkerInternals;
}

let worker: DownloadWorker;
let launched: string[];

beforeEach(() => {
  worker = new DownloadWorker();
  launched = [];
  // Stubbed so nothing touches the database or the network — the assertion is only about
  // *which* ids the scheduler decides to start.
  internals(worker).launchDownload = (id: string) => {
    launched.push(id);
  };
});

/** processQueue defers its work onto a microtask, so a tick has to be awaited. */
const drain = async () => {
  internals(worker).processQueue();
  await Promise.resolve();
  await Promise.resolve();
};

describe('DownloadWorker lifecycle', () => {
  it('re-queues a download resumed while its paused run is still unwinding', async () => {
    const w = internals(worker);
    w.downloadThreads.set('dl', new Promise(() => {}));
    w.pausedDownloads.add('dl');

    await worker.resumeDownload('dl');
    await drain();

    // Held back until the old run settles, not dropped.
    expect(w.queue).toEqual(['dl']);
    expect(launched).toEqual([]);

    w.downloadThreads.delete('dl');
    await drain();
    expect(launched).toEqual(['dl']);
  });

  it('leaves a download alone when resumed while it is really running', async () => {
    const w = internals(worker) as WorkerInternals & {
      activeDownloads: Map<string, AbortController>;
    };
    w.downloadThreads.set('dl', new Promise(() => {}));
    w.activeDownloads.set('dl', new AbortController());

    await worker.resumeDownload('dl');

    expect(w.queue).toEqual([]);
  });

  it('recovers queued and interrupted downloads, and keeps paused ones paused', async () => {
    const byStatus: Record<string, Array<{ id: string }>> = {
      PAUSED: [{ id: 'paused' }],
      IN_PROGRESS: [{ id: 'interrupted' }],
      PENDING: [{ id: 'interrupted' }, { id: 'waiting' }],
    };
    const repository = await import('../src/repositories/download.repository.js');
    const getByStatus = vi
      .spyOn(repository.default, 'getDownloadsByStatus')
      .mockImplementation(async (status: string) => byStatus[status] as never);
    const setStatus = vi
      .spyOn(repository.default, 'updateDownloadStatus')
      .mockResolvedValue({} as never);

    try {
      expect(await worker.recoverInterruptedDownloads()).toBe(2);
      await drain();

      expect(launched.sort()).toEqual(['interrupted', 'waiting']);
      expect(worker.isPaused('paused')).toBe(true);
      expect(setStatus).toHaveBeenCalledWith('interrupted', 'PENDING');
    } finally {
      getByStatus.mockRestore();
      setStatus.mockRestore();
    }
  });
});

describe('DownloadWorker queue scheduling', () => {
  it('reports a full queue instead of silently accepting dropped work', () => {
    const w = internals(worker);
    w.queue = Array.from({ length: 100 }, (_, i) => `queued-${i}`);
    expect(worker.addToQueue('overflow')).toBe(false);
    expect(w.queue).toHaveLength(100);
    expect(w.queue).not.toContain('overflow');
  });
  it('starts pending work even when skippable entries sit in front of it', async () => {
    const w = internals(worker);
    w.maxConcurrent = 3;
    // Three paused ids ahead of one real download, and three free slots. Counting
    // iterations, the paused three exhausted the budget and "real" never started.
    w.pausedDownloads = new Set(['p1', 'p2', 'p3']);
    w.queue = ['p1', 'p2', 'p3', 'real'];

    await drain();

    expect(launched).toEqual(['real']);
  });

  it('fills every free slot rather than stopping at the first skip', async () => {
    const w = internals(worker);
    w.maxConcurrent = 3;
    w.pausedDownloads = new Set(['p1']);
    w.queue = ['p1', 'a', 'b', 'c', 'd'];

    await drain();

    // Three slots, three launches — and `d` stays queued because the budget is spent on
    // work, not on skipping.
    expect(launched).toEqual(['a', 'b', 'c']);
    expect(w.queue).toEqual(['d']);
  });

  it('keeps a still-finishing download queued, ahead of what was behind it', async () => {
    const w = internals(worker);
    w.maxConcurrent = 2;
    // `busy` is mid-teardown: it must not be started twice, and must not lose its place.
    w.downloadThreads = new Map([['busy', Promise.resolve()]]);
    w.queue = ['busy', 'next'];

    await drain();

    expect(launched).toEqual(['next']);
    expect(w.queue).toEqual(['busy']);
  });

  it('terminates when every queued download is still finishing', async () => {
    const w = internals(worker);
    w.maxConcurrent = 3;
    w.downloadThreads = new Map([
      ['a', Promise.resolve()],
      ['b', Promise.resolve()],
    ]);
    w.queue = ['a', 'b'];

    // The regression guarded here is a hang, not a wrong result: re-queueing these inside
    // a loop that only exits on a launch would hand the same ids back to itself forever.
    await vi.waitFor(() => drain(), { timeout: 1000 });

    expect(launched).toEqual([]);
    expect(w.queue).toEqual(['a', 'b']);
  });

  it('respects a full concurrency budget by starting nothing', async () => {
    const w = internals(worker);
    w.maxConcurrent = 1;
    (w as unknown as { activeDownloads: Map<string, unknown> }).activeDownloads = new Map([
      // A real controller: the worker's SIGTERM handler aborts every active download, and
      // vitest can signal the worker process at teardown.
      ['running', new AbortController()],
    ]);
    w.queue = ['waiting'];

    await drain();

    expect(launched).toEqual([]);
    expect(w.queue).toEqual(['waiting']);
  });
});
