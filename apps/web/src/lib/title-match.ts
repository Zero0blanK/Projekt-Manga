import type { Mangas } from '@projekt-manga/types';
import { DUPLICATE_THRESHOLD, normalizeTitle, titleSimilarity } from './duplicate-detection';

/** A title found by name in one of a list of sources. */
export interface FoundTitle {
  sourceId: string;
  /** The source's own key for the title, as a search result gives it. */
  slug: string;
  /** The title as the source names it, shown in the review. */
  title: string;
  thumbnailUrl: string;
  /** 1 for an exact match after normalisation, otherwise the similarity score. */
  score: number;
}

export type SearchSource = (
  sourceId: string,
  query: string,
  signal?: AbortSignal,
) => Promise<Mangas[]>;

/** The best result for `title`, or null when none is close enough to be the same series. */
export function bestTitleMatch(
  title: string,
  results: Mangas[],
): { item: Mangas; score: number } | null {
  const wanted = normalizeTitle(title);
  if (!wanted) return null;
  let best: { item: Mangas; score: number } | null = null;
  for (const item of results) {
    const candidate = normalizeTitle(item.title);
    if (!candidate) continue;
    const score = candidate === wanted ? 1 : titleSimilarity(wanted, candidate);
    if (score >= DUPLICATE_THRESHOLD && (!best || score > best.score)) best = { item, score };
  }
  return best;
}

/**
 * Searches `sourceIds` for `query` in order and returns the first close enough match.
 * `lookup` returns null for a source that could not be searched, which counts as the
 * source not having the title.
 */
export async function findInSourceOrder(
  query: string,
  sourceIds: readonly string[],
  lookup: (sourceId: string, query: string) => Promise<Mangas[] | null>,
  signal?: AbortSignal,
): Promise<FoundTitle | null> {
  for (const sourceId of sourceIds) {
    signal?.throwIfAborted();
    const results = await lookup(sourceId, query);
    const best = results && bestTitleMatch(query, results);
    if (best)
      return {
        sourceId,
        slug: best.item.slug || best.item.id,
        title: best.item.title,
        thumbnailUrl: best.item.thumbnail_url,
        score: best.score,
      };
  }
  return null;
}
