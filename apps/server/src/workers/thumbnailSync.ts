import cacheService from '../services/cache.service.js';

/** How long a title's cover is left alone after a background attempt to cache it. */
const RETRY_AFTER_MS = 30 * 60 * 1000;
/** Titles remembered at once; the oldest attempt is forgotten first. */
const ATTEMPT_LIMIT = 5000;

type EnqueueOptions = {
  initiatedByUser?: boolean;
  /** Fetch even though a cache row exists: its file has gone missing. */
  force?: boolean;
  /** The title's source, so the fetch sends that source's image headers and session. */
  sourceId?: string;
};

/**
 * Serializes thumbnail fetches into a single chain so at most one `syncThumbnail` call
 * runs at a time, spaced ~150ms apart (`rateLimitMs`) — a library-wide sync walks every
 * title sequentially instead of hammering every source's image host at once.
 */
class ThumbnailQueue {
  private queue: Set<string> = new Set();
  private rateLimitMs = 150;
  private tail: Promise<void> = Promise.resolve();
  private attempts = new Map<string, number>();

  /** Chains onto the shared `tail` promise; a `manga_id` already queued is a no-op. */
  enqueue(manga_id: string, source_url: string, options: EnqueueOptions = {}) {
    if (this.queue.has(manga_id)) return;
    this.queue.add(manga_id);

    const run = this.tail.then(async () => {
      try {
        await cacheService.syncThumbnail(manga_id, source_url, options);
      } finally {
        this.queue.delete(manga_id);
        await new Promise((r) => setTimeout(r, this.rateLimitMs));
      }
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Caches a cover that was just shown without a cached copy, so the next time it comes
   * from disk, offline too. A title is tried at most once per half hour, so a cover whose
   * host refuses never turns every view into a second download.
   */
  cacheWhenShown(manga_id: string, source_url: string, options: EnqueueOptions = {}) {
    const now = Date.now();
    const last = this.attempts.get(manga_id);
    if (last !== undefined && now - last < RETRY_AFTER_MS) return;
    this.attempts.delete(manga_id);
    this.attempts.set(manga_id, now);
    while (this.attempts.size > ATTEMPT_LIMIT)
      this.attempts.delete(this.attempts.keys().next().value!);
    this.enqueue(manga_id, source_url, options);
  }

  isQueued(manga_id: string) {
    return this.queue.has(manga_id);
  }
}

const thumbnailQueue = new ThumbnailQueue();

export default thumbnailQueue;
