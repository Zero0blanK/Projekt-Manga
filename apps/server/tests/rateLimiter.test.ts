import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from '../src/workers/download.worker.js';

/**
 * The download worker runs up to `maxConcurrent` threads against the same source, so this
 * limiter's whole job is to hold the spacing when calls overlap. The previous version
 * read its timestamp, awaited, then wrote it back — three concurrent callers read the
 * same value, computed the same delay, and fired together. The spacing held only when
 * calls happened to be sequential, which is exactly when it wasn't needed.
 */
describe('RateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spaces concurrent callers instead of releasing them in a burst', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(100);
    const released: number[] = [];

    // All three claim a slot before any of them awaits a tick.
    const waits = [0, 1, 2].map((i) => limiter.wait().then(() => released.push(i)));

    await vi.advanceTimersByTimeAsync(0);
    expect(released).toEqual([0]); // first goes immediately

    await vi.advanceTimersByTimeAsync(99);
    expect(released).toEqual([0]); // second is still held

    await vi.advanceTimersByTimeAsync(1);
    expect(released).toEqual([0, 1]);

    await vi.advanceTimersByTimeAsync(100);
    expect(released).toEqual([0, 1, 2]);

    await Promise.all(waits);
  });

  it('does not delay a caller that arrives after the interval has already elapsed', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(100);

    await limiter.wait();
    await vi.advanceTimersByTimeAsync(500);

    let done = false;
    const pending = limiter.wait().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(done).toBe(true);
    await pending;
  });

  it('never drops below a 100ms floor, however high the configured rate', () => {
    const limiter = new RateLimiter(200);
    limiter.setInterval(5);
    // setInterval clamps rather than trusting the caller — a misconfigured
    // requests-per-second must not turn into an unthrottled flood at a source.
    expect(limiter).toMatchObject({ minInterval: 100 });
  });
});
