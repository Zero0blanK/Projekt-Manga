// TTLCache: in-memory cache with per-entry TTL, O(1) LRU eviction (Map insertion order,
// no sorting), in-flight request dedupe, optional stale-while-revalidate and background pruning.

type Millis = number;

export interface CacheOptions {
  /** Default TTL used when set()/getOrSet() is called without ttlMs */
  defaultTtlMs?: Millis;
  /** Max number of entries to keep (LRU-ish eviction) */
  maxSize?: number;
  /** If true, expired entries are removed during get()/has() */
  pruneOnGet?: boolean;

  /** Optional background pruning (set to 0/undefined to disable) */
  autoPruneIntervalMs?: Millis;

  /** Stale-while-revalidate grace period for getOrSet(): once a value passes its TTL
   *  but is still within this window, getOrSet() returns the stale value immediately
   *  and refreshes it in the background instead of blocking the caller on a refetch.
   *  0/undefined disables this (default). */
  staleTtlMs?: Millis;
}

type Entry<V> = {
  value: V;
  expiresAt: number; // epoch ms; Number.POSITIVE_INFINITY for no-expiry
};

export type CacheStats = {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  prunes: number;
  evictions: number;
  inFlightHits: number;
  staleHits: number;
};

export class TTLCache<K, V> {
  private readonly store = new Map<K, Entry<V>>();
  private readonly inFlight = new Map<K, Promise<V>>();
  private readonly defaultTtlMs: Millis;
  private readonly maxSize: number;
  private readonly pruneOnGet: boolean;
  private readonly staleTtlMs: Millis;

  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    prunes: 0,
    evictions: 0,
    inFlightHits: 0,
    staleHits: 0,
  };

  private pruneTimer?: NodeJS.Timeout;

  constructor(defaultTtlMs: Millis = 60_000, maxSize: number = 500, opts?: CacheOptions) {
    this.defaultTtlMs = opts?.defaultTtlMs ?? defaultTtlMs;
    this.maxSize = opts?.maxSize ?? maxSize;
    this.pruneOnGet = opts?.pruneOnGet ?? true;
    this.staleTtlMs = opts?.staleTtlMs ?? 0;

    const interval = opts?.autoPruneIntervalMs;
    if (interval && interval > 0) {
      this.pruneTimer = setInterval(() => this.pruneExpired(), interval);
      // Pruning alone must not keep the process alive.
      this.pruneTimer.unref?.();
    }
  }

  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
    }
    this.pruneTimer = undefined;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      prunes: 0,
      evictions: 0,
      inFlightHits: 0,
      staleHits: 0,
    };
  }

  get size() {
    return this.store.size;
  }

  has(key: K): boolean {
    const e = this.store.get(key);
    if (!e) {
      return false;
    }

    if (this.isExpired(e)) {
      if (this.pruneOnGet) {
        this.store.delete(key);
      }
      return false;
    }
    return true;
  }

  get(key: K): V | undefined {
    const e = this.store.get(key);
    if (!e) {
      this.stats.misses++;
      return undefined;
    }

    if (this.isExpired(e)) {
      if (this.pruneOnGet) {
        this.store.delete(key);
      }
      this.stats.misses++;
      return undefined;
    }

    this.touch(key, e);
    this.stats.hits++;
    return e.value;
  }

  set(key: K, value: V, ttlMs?: Millis): void {
    const now = Date.now();
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl <= 0 ? now : now + ttl;

    // Delete first: Map.set() on an existing key keeps its old iteration position, but
    // a re-set key must become most-recently-used.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt });
    this.stats.sets++;
    this.evictIfNeeded();
  }

  /** Moves a key to the most-recently-used position (end of Map iteration order). */
  private touch(key: K, entry: Entry<V>): void {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  delete(key: K): boolean {
    this.inFlight.delete(key);
    const ok = this.store.delete(key);
    if (ok) {
      this.stats.deletes++;
    }
    return ok;
  }

  clear(): void {
    this.inFlight.clear();
    this.store.clear();
  }

  pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, e] of this.store) {
      if (e.expiresAt + this.staleTtlMs <= now) {
        this.store.delete(k);
        removed++;
      }
    }
    if (removed > 0) {
      this.stats.prunes += removed;
    }
    return removed;
  }

  /** Dedupe concurrent fetches, then cache result. When staleTtlMs is set, a value
   *  that's past its TTL but still within the stale grace window is returned
   *  immediately while a background refresh populates the next fresh value. */
  async getOrSet(key: K, factory: () => Promise<V>, ttlMs?: Millis): Promise<V> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (entry) {
      if (entry.expiresAt > now) {
        this.touch(key, entry);
        this.stats.hits++;
        return entry.value;
      }

      if (this.staleTtlMs > 0 && entry.expiresAt + this.staleTtlMs > now) {
        this.touch(key, entry);
        this.stats.hits++;
        this.stats.staleHits++;
        this.refreshInBackground(key, factory, ttlMs);
        return entry.value;
      }
    }

    this.stats.misses++;

    const existing = this.inFlight.get(key);
    if (existing) {
      this.stats.inFlightHits++;
      return existing;
    }

    const p = (async () => {
      try {
        const value = await factory();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, p);
    return p;
  }

  /** Fire-and-forget refresh used by the stale-while-revalidate path. Leaves the
   *  stale value in place on failure so callers keep getting a usable response.
   *  Shares the inFlight map with getOrSet()'s normal miss path so a concurrent
   *  true miss on the same key dedupes against this refresh instead of firing a
   *  second factory() call. */
  private refreshInBackground(key: K, factory: () => Promise<V>, ttlMs?: Millis): void {
    if (this.inFlight.has(key)) {
      return;
    }

    const p = (async () => {
      const value = await factory();
      this.set(key, value, ttlMs);
      return value;
    })();

    this.inFlight.set(key, p);
    // Registering a handler here marks the rejection as observed for Node's
    // unhandled-rejection detector even if no concurrent caller ends up awaiting `p`.
    p.catch(() => undefined).finally(() => {
      this.inFlight.delete(key);
    });
  }

  private isExpired(e: Entry<V>): boolean {
    return e.expiresAt <= Date.now();
  }

  /** The least-recently-used entry is always the first key in Map iteration order (see touch()). */
  private evictIfNeeded(): void {
    while (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
      this.stats.evictions++;
    }
  }
}
