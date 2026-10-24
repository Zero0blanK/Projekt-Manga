// UpdateQueue: serializes chapter-list updates (one at a time, rate limited) and ignores
// slugs that are already queued.

export class UpdateQueue {
  private queue: Set<string> = new Set();
  private rateLimitMs = 250; // 4 requests per second for MangaDex
  private tail: Promise<void> = Promise.resolve();

  async add<T>(manga_slug: string, updateFn: () => Promise<T>, emptyValue: T): Promise<T> {
    if (this.queue.has(manga_slug)) {
      return emptyValue;
    }

    this.queue.add(manga_slug);
    const run = this.tail.then(async () => {
      try {
        return await updateFn();
      } finally {
        this.queue.delete(manga_slug);
        await new Promise((resolve) => setTimeout(resolve, this.rateLimitMs));
      }
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  isQueued(manga_slug: string): boolean {
    return this.queue.has(manga_slug);
  }
}
