import { describe, expect, it } from 'vitest';
import { HostLimiter } from '../src/utils/hostLimiter.js';

describe('HostLimiter', () => {
  it('runs at most the cap per host, in arrival order, and other hosts independently', async () => {
    const limiter = new HostLimiter(2);
    const running = new Map<string, number>();
    const peak = new Map<string, number>();
    const order: number[] = [];
    const task = (host: string, id: number) =>
      limiter.run(host, async () => {
        running.set(host, (running.get(host) ?? 0) + 1);
        peak.set(host, Math.max(peak.get(host) ?? 0, running.get(host)!));
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(id);
        running.set(host, running.get(host)! - 1);
      });
    await Promise.all([
      ...[1, 2, 3, 4, 5].map((id) => task('a.example', id)),
      task('b.example', 9),
    ]);
    expect(peak.get('a.example')).toBe(2);
    expect(peak.get('b.example')).toBe(1);
    expect(order.filter((id) => id !== 9)).toEqual([1, 2, 3, 4, 5]);
  });

  it('releases the slot when a task fails', async () => {
    const limiter = new HostLimiter(1);
    await expect(
      limiter.run('a.example', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(limiter.run('a.example', async () => 'next')).resolves.toBe('next');
  });
});
