'use client';

/**
 * What a source card already showed about a title (its name and cover), kept for the
 * title page that card opens. The page's own details come from a live scrape that can take
 * seconds; with this the page shows the title and cover at once and fills in the rest as it
 * streams, instead of a blank skeleton.
 *
 * In memory only and per tab: a reload or a link opened elsewhere has no seed and shows
 * the plain skeleton, as before.
 */
export interface SourcePreviewSeed {
  title: string;
  /** Already proxied, as the card displayed it; null when the source sent none. */
  thumbnailUrl: string | null;
}

/** Enough for a long browsing session; the oldest entries go first. */
const LIMIT = 200;
const seeds = new Map<string, SourcePreviewSeed>();

const key = (sourceId: string, mangaId: string) => `${sourceId}\0${mangaId}`;

export function rememberSourcePreview(
  sourceId: string,
  mangaId: string,
  seed: SourcePreviewSeed,
): void {
  const id = key(sourceId, mangaId);
  seeds.delete(id);
  seeds.set(id, seed);
  while (seeds.size > LIMIT) seeds.delete(seeds.keys().next().value!);
}

export function sourcePreviewSeed(sourceId: string, mangaId: string): SourcePreviewSeed | null {
  return seeds.get(key(sourceId, mangaId)) ?? null;
}

/** For tests. */
export function clearSourcePreviewSeeds(): void {
  seeds.clear();
}
