import { describe, expect, it } from 'vitest';
import { mapConcurrent } from '@/lib/map-concurrent';

describe('mapConcurrent', () => {
  it('never exceeds the limit and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5 - (n % 3)));
      inFlight--;
      return n * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });

  it('rejects with the first error and stops starting new work', async () => {
    const started: number[] = [];
    await expect(
      mapConcurrent([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});
