/**
 * Caps how many requests run at once against one upstream host.
 *
 * A reader opens a chapter and asks for every page at once; forwarding that burst
 * unchanged to an image CDN gets the server rate-limited or blocked. Requests beyond the cap wait their turn,
 * in arrival order, instead of being sent.
 */
export class HostLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();

  constructor(private readonly perHost: number) {}

  async run<T>(host: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(host);
    try {
      return await task();
    } finally {
      this.release(host);
    }
  }

  private acquire(host: string): Promise<void> {
    const running = this.active.get(host) ?? 0;
    if (running < this.perHost) {
      this.active.set(host, running + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const queue = this.waiting.get(host) ?? [];
      queue.push(resolve);
      this.waiting.set(host, queue);
    });
  }

  private release(host: string): void {
    const queue = this.waiting.get(host);
    const next = queue?.shift();
    if (next) {
      // The slot passes straight to the next waiter; the active count is unchanged.
      if (!queue!.length) this.waiting.delete(host);
      next();
      return;
    }
    const running = (this.active.get(host) ?? 1) - 1;
    if (running <= 0) this.active.delete(host);
    else this.active.set(host, running);
  }
}
