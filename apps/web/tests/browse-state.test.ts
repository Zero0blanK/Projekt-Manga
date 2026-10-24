import { beforeEach, describe, expect, it } from 'vitest';
import {
  browseQueryKey,
  clearAllBrowseSnapshots,
  readBrowseSnapshot,
  saveBrowseSnapshot,
} from '@/lib/browse-state';

const snapshot = {
  sourceId: 'source-a',
  category: 'popular',
  query: '',
  sortValue: 'rating',
  filterValues: { status: 'ongoing' },
  items: [],
  hasMore: true,
  nextCursor: 'opaque-page-2',
  scrollY: 500,
};

beforeEach(() => sessionStorage.clear());

describe('browse snapshot identity', () => {
  it('keys by source, category, sort, and filters regardless of filter insertion order', () => {
    const first = { ...snapshot, filterValues: { status: 'ongoing', genre: 'action' } };
    expect(browseQueryKey('popular', first)).toBe(
      browseQueryKey('popular', {
        ...first,
        filterValues: { genre: 'action', status: 'ongoing' },
      }),
    );
    for (const changed of [
      { ...first, sourceId: 'source-b' },
      { ...first, category: 'latest' },
      { ...first, query: 'different title' },
      { ...first, sortValue: 'follows' },
      { ...first, filterValues: { genre: 'comedy' } },
    ]) {
      expect(browseQueryKey('popular', changed)).not.toBe(browseQueryKey('popular', first));
    }
  });

  it('restores only the requested source and category, then clears on extension changes', () => {
    saveBrowseSnapshot('popular', snapshot);
    saveBrowseSnapshot('popular', { ...snapshot, sourceId: 'source-b', scrollY: 900 });

    expect(readBrowseSnapshot('popular', 'popular', 'source-a')?.scrollY).toBe(500);
    expect(readBrowseSnapshot('popular', 'popular', 'source-b')?.scrollY).toBe(900);
    expect(readBrowseSnapshot('popular', 'latest', 'source-a')).toBeNull();

    clearAllBrowseSnapshots();
    expect(readBrowseSnapshot('popular', 'popular', 'source-a')).toBeNull();
    expect(readBrowseSnapshot('popular', 'popular', 'source-b')).toBeNull();
  });

  it('rejects stale and corrupted entries', () => {
    saveBrowseSnapshot('popular', snapshot);
    const key = browseQueryKey('popular', snapshot);
    sessionStorage.setItem(key, JSON.stringify({ ...snapshot, savedAt: Date.now() - 31 * 60_000 }));
    expect(readBrowseSnapshot('popular', 'popular', 'source-a')).toBeNull();
    sessionStorage.setItem(key, '5');
    expect(readBrowseSnapshot('popular', 'popular', 'source-a')).toBeNull();
  });
});
