import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateQueue } from '../utils/updateQueue.js';

describe('UpdateQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('isQueued is false before add(), true while pending, false once resolved', async () => {
    const queue = new UpdateQueue();
    expect(queue.isQueued('slug-a')).toBe(false);

    const promise = queue.add('slug-a', async () => 'result', 'empty');
    expect(queue.isQueued('slug-a')).toBe(true);

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('result');
    expect(queue.isQueued('slug-a')).toBe(false);
  });

  it('returns emptyValue for a duplicate add() of an already-queued slug, without invoking updateFn twice', async () => {
    const queue = new UpdateQueue();
    const updateFn = vi.fn(async () => 'real');

    const first = queue.add('slug-b', updateFn, 'empty');
    const second = await queue.add('slug-b', updateFn, 'empty');

    expect(second).toBe('empty');

    await vi.runAllTimersAsync();
    await first;

    expect(updateFn).toHaveBeenCalledTimes(1);
  });

  it('runs queued updates for different slugs sequentially, not concurrently', async () => {
    const queue = new UpdateQueue();
    const order: string[] = [];

    const p1 = queue.add(
      'slug-c',
      async () => {
        order.push('c-start');
        order.push('c-end');
        return 'c';
      },
      '',
    );
    const p2 = queue.add(
      'slug-d',
      async () => {
        order.push('d-start');
        order.push('d-end');
        return 'd';
      },
      '',
    );

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(order).toEqual(['c-start', 'c-end', 'd-start', 'd-end']);
  });

  it('propagates a rejection from updateFn and still clears the queue afterward', async () => {
    const queue = new UpdateQueue();

    const failing = queue.add(
      'slug-e',
      async () => {
        throw new Error('boom');
      },
      'empty',
    );
    // Attach the rejection assertion before advancing fake timers, so the handler is in
    // place before updateQueue.ts's post-failure setTimeout(this.rateLimitMs) actually
    // rejects `failing` — otherwise Node briefly sees it as an unhandled rejection.
    const assertion = expect(failing).rejects.toThrow('boom');

    await vi.runAllTimersAsync();
    await assertion;
    expect(queue.isQueued('slug-e')).toBe(false);
  });

  it('allows re-queuing the same slug once the previous run has cleared it', async () => {
    const queue = new UpdateQueue();
    const updateFn = vi.fn(async () => 'ok');

    const first = queue.add('slug-f', updateFn, 'empty');
    await vi.runAllTimersAsync();
    await first;

    const second = queue.add('slug-f', updateFn, 'empty');
    await vi.runAllTimersAsync();
    await second;

    expect(updateFn).toHaveBeenCalledTimes(2);
  });
});
