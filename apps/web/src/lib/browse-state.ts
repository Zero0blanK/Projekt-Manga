'use client';

import type { Mangas } from '@projekt-manga/types';
import type { FilterValues } from '@/lib/filter-values';

/**
 * Snapshot of a discover browse session, kept in sessionStorage so returning from a
 * manga preview restores what was on screen. Without it, going back re-mounts the page
 * with empty state: filters and sort reset, every infinitely-scrolled page is dropped,
 * and the browser lands at scroll 0 because the tall list no longer exists to scroll to.
 */
export type BrowseSnapshot = {
  sourceId: string | null;
  category: string;
  query: string;
  sortValue: string;
  filterValues: FilterValues;
  displayLanguage?: string;
  items: Mangas[];
  hasMore: boolean;
  nextCursor?: string;
  scrollY: number;
  savedAt: number;
};

/** Snapshots are a convenience, not a cache — anything older than this is re-fetched so
 * a returning reader isn't shown a stale catalog. */
const MAX_AGE_MS = 30 * 60 * 1000;

/** Beyond this the JSON threatens the sessionStorage quota. Truncating isn't an option
 * because `nextCursor` is opaque and would skip the dropped rows, so an oversized list is
 * not saved and is re-fetched on return. */
const MAX_SNAPSHOT_ITEMS = 600;

const PREFIX = 'projekt-manga:browse:v5:';
const pagePrefix = (page: string) => `${PREFIX}${page}:`;
const latestKey = (page: string, sourceId?: string) =>
  `${pagePrefix(page)}latest:${sourceId === undefined ? 'page' : encodeURIComponent(sourceId)}`;

/** Source, category, sort and filters all affect the returned rows. */
export function browseQueryKey(
  page: string,
  snapshot: Pick<
    BrowseSnapshot,
    'sourceId' | 'category' | 'query' | 'sortValue' | 'filterValues' | 'displayLanguage'
  >,
): string {
  const filters = Object.entries(snapshot.filterValues).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `${pagePrefix(page)}query:${encodeURIComponent(JSON.stringify([snapshot.sourceId, snapshot.category, snapshot.query, snapshot.sortValue, filters, ...(snapshot.displayLanguage && snapshot.displayLanguage !== 'all' ? [snapshot.displayLanguage] : [])]))}`;
}

export function saveBrowseSnapshot(page: string, snapshot: Omit<BrowseSnapshot, 'savedAt'>) {
  if (typeof window === 'undefined' || snapshot.items.length > MAX_SNAPSHOT_ITEMS) return;
  try {
    const key = browseQueryKey(page, snapshot);
    const sourcePointer = latestKey(page, snapshot.sourceId ?? '');
    const previous = sessionStorage.getItem(sourcePointer);
    sessionStorage.setItem(
      key,
      JSON.stringify({ ...snapshot, savedAt: Date.now() } satisfies BrowseSnapshot),
    );
    sessionStorage.setItem(sourcePointer, key);
    sessionStorage.setItem(latestKey(page), key);
    if (previous && previous !== key) sessionStorage.removeItem(previous);
  } catch {
    /* quota or private mode — restoring is optional, so degrade silently */
  }
}

/**
 * A truthiness check isn't enough. Anything that survives `JSON.parse` — `5`, `[]`, an
 * object with a different shape — passes `!parsed`, and a missing `savedAt` makes the
 * staleness check `NaN > MAX_AGE_MS`, which is false, so the junk would be returned as a
 * snapshot and crash the first consumer to read `snapshot.items.length`. Validate the
 * fields actually read.
 */
function isBrowseSnapshot(value: unknown): value is BrowseSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<BrowseSnapshot>;
  return (
    typeof v.savedAt === 'number' &&
    Number.isFinite(v.savedAt) &&
    Array.isArray(v.items) &&
    typeof v.category === 'string' &&
    typeof v.query === 'string' &&
    (v.displayLanguage === undefined || typeof v.displayLanguage === 'string') &&
    typeof v.hasMore === 'boolean' &&
    (v.nextCursor === undefined || (typeof v.nextCursor === 'string' && v.nextCursor.length > 0)) &&
    (!v.hasMore || !!v.nextCursor) &&
    typeof v.sortValue === 'string' &&
    typeof v.scrollY === 'number' &&
    typeof v.filterValues === 'object' &&
    v.filterValues !== null &&
    (v.sourceId === null || typeof v.sourceId === 'string')
  );
}

export function readBrowseSnapshot(
  page: string,
  category: string,
  sourceId?: string | null,
): BrowseSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const key = sessionStorage.getItem(latestKey(page, sourceId ?? undefined));
    if (!key?.startsWith(`${pagePrefix(page)}query:`)) return null;
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isBrowseSnapshot(parsed)) return null;
    if (parsed.category !== category || (sourceId && parsed.sourceId !== sourceId)) return null;
    if (browseQueryKey(page, parsed) !== key) return null;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearBrowseSnapshot(page: string) {
  if (typeof window === 'undefined') return;
  try {
    const prefix = pagePrefix(page);
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

export function clearAllBrowseSnapshots(): void {
  if (typeof window === 'undefined') return;
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    /* session storage is optional */
  }
}
