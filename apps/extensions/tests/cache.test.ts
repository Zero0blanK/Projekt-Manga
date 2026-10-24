import { describe, it, expect, vi } from 'vitest';
import { TTLCache } from '../utils/cache.js';

describe('TTLCache basic get/set', () => {
  it('returns undefined for a missing key', () => {
    const cache = new TTLCache<string, number>();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('stores and retrieves a value', () => {
    const cache = new TTLCache<string, number>();
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('expires a value past its TTL', async () => {
    const cache = new TTLCache<string, number>(9999, 100);
    cache.set('a', 1, 20);
    expect(cache.get('a')).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.get('a')).toBeUndefined();
  });

  it('deletes a key', () => {
    const cache = new TTLCache<string, number>();
    cache.set('a', 1);
    expect(cache.delete('a')).toBe(true);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.delete('a')).toBe(false);
  });

  it('clears everything', () => {
    const cache = new TTLCache<string, number>();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('TTLCache LRU eviction', () => {
  it('evicts the least-recently-used entry, not the oldest-inserted one', () => {
    const cache = new TTLCache<string, string>(100000, 3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');

    // Touch 'a' via get() so it becomes most-recently-used.
    expect(cache.get('a')).toBe('A');

    // Insert a 4th key — should evict 'b' (LRU), not 'a'.
    cache.set('d', 'D');

    expect(cache.get('a')).toBe('A');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('C');
    expect(cache.get('d')).toBe('D');
    expect(cache.getStats().evictions).toBe(1);
  });

  it('re-setting an existing key moves it to the most-recently-used position', () => {
    const cache = new TTLCache<string, string>(100000, 2);
    cache.set('a', 'A');
    cache.set('b', 'B');

    // Re-set 'a' — it should now be MRU, so 'b' becomes LRU.
    cache.set('a', 'A2');
    cache.set('c', 'C');

    expect(cache.get('a')).toBe('A2');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('C');
  });
});

describe('TTLCache.getOrSet', () => {
  it('caches the factory result and does not call the factory again on a hit', async () => {
    const cache = new TTLCache<string, string>();
    const factory = vi.fn(async () => 'value');

    const first = await cache.getOrSet('k', factory);
    const second = await cache.getOrSet('k', factory);

    expect(first).toBe('value');
    expect(second).toBe('value');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent calls for the same key into a single factory invocation', async () => {
    const cache = new TTLCache<string, string>();
    let calls = 0;
    const factory = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return `value-${calls}`;
    });

    const [a, b, c] = await Promise.all([
      cache.getOrSet('k', factory),
      cache.getOrSet('k', factory),
      cache.getOrSet('k', factory),
    ]);

    expect(a).toBe('value-1');
    expect(b).toBe('value-1');
    expect(c).toBe('value-1');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected factory result', async () => {
    const cache = new TTLCache<string, string>();
    await expect(
      cache.getOrSet('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(cache.has('k')).toBe(false);
  });
});

describe('TTLCache stale-while-revalidate', () => {
  it('serves the stale value immediately past TTL and refreshes in the background', async () => {
    const cache = new TTLCache<string, string>(50, 100, { staleTtlMs: 300 });
    let calls = 0;
    const factory = vi.fn(async () => {
      calls++;
      return `value-${calls}`;
    });

    expect(await cache.getOrSet('k', factory, 50)).toBe('value-1');

    await new Promise((r) => setTimeout(r, 70)); // past TTL, within stale window

    const stale = await cache.getOrSet('k', factory, 50);
    expect(stale).toBe('value-1'); // stale value returned immediately
    expect(cache.getStats().staleHits).toBe(1);

    await new Promise((r) => setTimeout(r, 20)); // let background refresh land

    expect(await cache.getOrSet('k', factory, 50)).toBe('value-2');
  });

  it('dedupes concurrent stale reads into a single background refresh', async () => {
    const cache = new TTLCache<string, string>(30, 100, { staleTtlMs: 300 });
    let calls = 0;
    const factory = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return `value-${calls}`;
    });

    await cache.getOrSet('k', factory, 30);
    await new Promise((r) => setTimeout(r, 40)); // past TTL, within stale window

    const results = await Promise.all([
      cache.getOrSet('k', factory, 30),
      cache.getOrSet('k', factory, 30),
      cache.getOrSet('k', factory, 30),
    ]);

    expect(results).toEqual(['value-1', 'value-1', 'value-1']);
    expect(calls).toBe(2); // one initial fetch + one deduped background refresh
  });

  it('falls back to a blocking fetch once past the stale grace window', async () => {
    const cache = new TTLCache<string, string>(20, 100, { staleTtlMs: 30 });
    let calls = 0;
    const factory = vi.fn(async () => {
      calls++;
      return `value-${calls}`;
    });

    await cache.getOrSet('k', factory, 20);
    await new Promise((r) => setTimeout(r, 80)); // past TTL + staleTtlMs entirely

    const result = await cache.getOrSet('k', factory, 20);
    expect(result).toBe('value-2');
    expect(calls).toBe(2);
  });
});

describe('TTLCache.pruneExpired', () => {
  it('removes hard-expired entries but keeps entries still within the stale grace window', async () => {
    const cache = new TTLCache<string, string>(20, 100, { staleTtlMs: 200 });
    cache.set('a', 'A', 20);

    await new Promise((r) => setTimeout(r, 40)); // past TTL, within stale grace
    expect(cache.pruneExpired()).toBe(0);

    await new Promise((r) => setTimeout(r, 200)); // past TTL + stale grace
    expect(cache.pruneExpired()).toBe(1);
  });
});
