import { isTallPage } from '@/lib/page-image';

/**
 * Spotting a webtoon (tall, narrow strip pages) and opening it as one long strip.
 *
 * A strip page in a two-page spread or single-page view shrinks to a sliver a few dozen
 * pixels wide, so a title whose first pages are strips reads as a long strip unless the
 * reader chose a paged layout for that title specifically. The global page layout alone
 * doesn't count as that choice: it is set once for every title, mostly with manga in mind.
 */

/** Pages seen so far: how many loaded, and how many of those were tall strips. */
export type PageShapeTally = { seen: number; tall: number };

/** How many pages to see before judging, so one tall cover or credits page doesn't. */
const MIN_PAGES_SEEN = 3;
/** The share of seen pages that must be strips. */
const MIN_TALL_SHARE = 2 / 3;

/** Counts one loaded page into the tally. */
export function tallyPageShape(tally: PageShapeTally, width: number, height: number) {
  return { seen: tally.seen + 1, tall: tally.tall + (isTallPage(width, height) ? 1 : 0) };
}

/** Whether the pages seen so far look like a webtoon's. */
export function looksLikeWebtoon({ seen, tall }: PageShapeTally): boolean {
  return seen >= MIN_PAGES_SEEN && tall / seen >= MIN_TALL_SHARE;
}

/**
 * The layout the reader shows. A webtoon opens as a long strip whatever the configured
 * layout, unless this title has its own reader override with a paged layout: that is an
 * explicit choice for this title and wins.
 */
export function resolveWebtoonLayout({
  layout,
  webtoon,
  titleLayout,
}: {
  /** The configured layout, already resolved (global setting, title override, screen). */
  layout: string;
  /** Whether this title's pages were found to be tall strips. */
  webtoon: boolean;
  /** The page layout of this title's reader override, or null without one. */
  titleLayout: string | null;
}): string {
  if (!webtoon || layout === 'Long strip') return layout;
  if (titleLayout && titleLayout !== 'Long strip') return layout;
  return 'Long strip';
}
