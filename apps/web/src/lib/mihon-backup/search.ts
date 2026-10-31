import type { Mangas } from '@projekt-manga/types';
import {
  bestTitleMatch,
  findInSourceOrder,
  type FoundTitle,
  type SearchSource,
} from '@/lib/title-match';
import type { MihonBackup } from './decode';

export { bestTitleMatch };
export type { FoundTitle, SearchSource };

export interface TitleSearchResult {
  /** Backup manga index → where it was found. */
  found: Map<number, FoundTitle>;
  /** Backup manga indexes searched in every listed source without a match. */
  missing: number[];
  /** Installed source ids that failed at least one search. */
  failedSources: string[];
}

export interface TitleSearchProgress {
  done: number;
  total: number;
}

/** Titles searched at once. Each source's own rate limit still spaces its requests. */
const CONCURRENCY = 3;

/**
 * For each library title whose Mihon source has no direct match, searches the listed
 * installed sources by the title's name, in the listed order, and stops at the first
 * source with a close enough result. A source that fails is treated as not having the
 * title, so the next one is tried.
 */
export async function findTitlesInSources(
  backup: MihonBackup,
  direct: ReadonlyMap<string, string | null>,
  orders: ReadonlyMap<string, readonly string[]>,
  search: SearchSource,
  options: { signal?: AbortSignal; onProgress?: (progress: TitleSearchProgress) => void } = {},
): Promise<TitleSearchResult> {
  const queue = backup.manga.flatMap((title, index) =>
    title.favorite && title.title.trim() && !direct.get(title.source)
      ? (orders.get(title.source) ?? []).length
        ? [index]
        : []
      : [],
  );
  const found = new Map<number, FoundTitle>();
  const missing: number[] = [];
  const failed = new Set<string>();
  // Duplicate titles in one backup share their searches.
  const cache = new Map<string, Promise<Mangas[] | null>>();
  const lookup = (sourceId: string, query: string) => {
    const key = `${sourceId}\0${query}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = search(sourceId, query, options.signal).catch(() => {
        options.signal?.throwIfAborted();
        failed.add(sourceId);
        return null;
      });
      cache.set(key, pending);
    }
    return pending;
  };

  let next = 0;
  let done = 0;
  options.onProgress?.({ done, total: queue.length });
  const worker = async () => {
    while (next < queue.length) {
      const index = queue[next++];
      const title = backup.manga[index];
      const query = title.title.trim();
      const match = await findInSourceOrder(
        query,
        orders.get(title.source) ?? [],
        lookup,
        options.signal,
      );
      if (match) found.set(index, match);
      else missing.push(index);
      done += 1;
      options.onProgress?.({ done, total: queue.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return { found, missing: missing.sort((a, b) => a - b), failedSources: [...failed] };
}
