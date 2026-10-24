import type { Manga } from './manga-data';

/**
 * Finds library entries that look like the same series as one you're about to add from a
 * source.
 *
 * Runs entirely on the client against the already-loaded library list, with no server
 * round-trip. The library is small enough for a linear scan, and the check runs once per add.
 *
 * Titles are the only thing two sources reliably agree on. They don't agree on much else:
 * the same series appears as "Kanojo, Okarishimasu", "Rent-A-Girlfriend",
 * "Rent a Girlfriend (Official)" and "Kanojo Okarishimasu [Colored]" across sites, so a
 * raw string comparison finds almost nothing. Hence: normalise hard, then compare.
 */

/** Suffixes sources bolt on that say nothing about which series this is. */
const NOISE_PATTERNS: RegExp[] = [
  /\b(official|fan\s*colored|colou?red|uncensored|censored|digital|webtoon|manhwa|manhua|novel|light\s*novel|raw|scan|remastered|full\s*color)\b/g,
  /\b(season|part|vol|volume|chapter|ch)\s*\.?\s*\d+\b/g,
];

/**
 * Reduces a title to the part that identifies the series.
 *
 * Strips bracketed asides first (they hold the noise: "[Colored]", "(Official)"), then
 * diacritics, then punctuation. Latin-script punctuation removal is safe here, but the
 * character class deliberately keeps letters and digits in every script — stripping
 * anything non-ASCII would collapse a CJK title to an empty string and make every
 * Japanese-titled series a duplicate of every other.
 */
export function normalizeTitle(title: string): string {
  let out = title.toLowerCase();

  // Bracketed asides, before punctuation removal makes them unrecognisable.
  out = out.replace(/[[({][^\])}]*[\])}]/g, ' ');

  // Diacritics: "Pokémon" and "Pokemon" are the same series.
  out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');

  for (const pattern of NOISE_PATTERNS) {
    out = out.replace(pattern, ' ');
  }

  // Keep letters/digits in any script; everything else becomes a separator.
  out = out.replace(/[^\p{L}\p{N}]+/gu, ' ');

  return out.trim().replace(/\s+/g, ' ');
}

/**
 * Sørensen–Dice coefficient over character bigrams, 0–1.
 *
 * Chosen over edit distance because it's insensitive to word order and to a missing or
 * extra word — the two ways source titles actually differ ("Rent-A-Girlfriend" vs
 * "Rent a Girlfriend Official"). Edit distance would punish the length difference far
 * more than the shared content warrants.
 */
export function titleSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      shared++;
    }
  }

  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/**
 * Below this, matches are noise. Tuned so real cross-source variants of a title match
 * while genuinely different series in a long-running franchise do not — the hard cases
 * are sequels sharing a stem ("Attack on Titan" vs "Attack on Titan: Before the Fall"),
 * which is exactly why this asks rather than deciding on the reader's behalf.
 */
export const DUPLICATE_THRESHOLD = 0.8;

export interface DuplicateMatch {
  manga: Manga;
  /** 1 for an exact match after normalisation, otherwise the similarity score. */
  score: number;
  exact: boolean;
}

/**
 * Library entries that look like `title`, best match first.
 *
 * `excludeSource`/`excludeSlug` skip the title's own row: re-visiting a series you already
 * added from this same source is not a duplicate, it's the entry itself, and the add
 * button is already disabled in that case.
 */
export function findLibraryDuplicates(
  title: string,
  library: Manga[],
  options: { excludeSource?: string; excludeSlug?: string } = {},
): DuplicateMatch[] {
  const normalized = normalizeTitle(title);
  if (!normalized) return [];

  const matches: DuplicateMatch[] = [];

  for (const manga of library) {
    if (!manga.inLibrary) continue;
    if (
      options.excludeSource &&
      manga.source === options.excludeSource &&
      manga.slug === options.excludeSlug
    ) {
      continue;
    }

    const candidate = normalizeTitle(manga.title);
    if (!candidate) continue;

    if (candidate === normalized) {
      matches.push({ manga, score: 1, exact: true });
      continue;
    }

    const score = titleSimilarity(normalized, candidate);
    if (score >= DUPLICATE_THRESHOLD) {
      matches.push({ manga, score, exact: false });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}
