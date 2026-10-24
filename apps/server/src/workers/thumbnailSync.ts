import cacheService from '../services/cache.service.js';

/**
 * Serializes thumbnail fetches into a single chain so at most one `syncThumbnail` call
 * runs at a time, spaced ~150ms apart (`rateLimitMs`) — a library-wide sync walks every
 * title sequentially instead of hammering every source's image host at once.
 */
class ThumbnailQueue {
  private queue: Set<string> = new Set();
  private rateLimitMs = 150;
  private tail: Promise<void> = Promise.resolve();

  /** Chains onto the shared `tail` promise; a `manga_id` already queued is a no-op. */
  enqueue(manga_id: string, source_url: string, initiatedByUser = false) {
    if (this.queue.has(manga_id)) return;
    this.queue.add(manga_id);

    const run = this.tail.then(async () => {
      try {
        await cacheService.syncThumbnail(manga_id, source_url, { initiatedByUser });
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

  isQueued(manga_id: string) {
    return this.queue.has(manga_id);
  }
}

const thumbnailQueue = new ThumbnailQueue();

export default thumbnailQueue;
