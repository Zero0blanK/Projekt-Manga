import { describe, expect, it } from 'vitest';
import {
  looksLikeWebtoon,
  resolveWebtoonLayout,
  tallyPageShape,
  type PageShapeTally,
} from '@/lib/webtoon-layout';

const tally = (sizes: [number, number][]): PageShapeTally =>
  sizes.reduce((acc, [w, h]) => tallyPageShape(acc, w, h), { seen: 0, tall: 0 });

/** The layout the reader shows for a chapter whose first pages have these sizes. */
const layoutFor = (
  sizes: [number, number][],
  layout = 'Two-page spread',
  titleLayout: string | null = null,
) => resolveWebtoonLayout({ layout, webtoon: looksLikeWebtoon(tally(sizes)), titleLayout });

const strips: [number, number][] = [
  [800, 12000],
  [800, 9000],
  [720, 5000],
];
const mangaPages: [number, number][] = [
  [1000, 1500],
  [1000, 1500],
  [2000, 1500],
];

describe('webtoon layout', () => {
  it('opens tall strip pages as a long strip, from either paged layout', () => {
    expect(layoutFor(strips)).toBe('Long strip');
    expect(layoutFor(strips, 'Single page')).toBe('Long strip');
  });

  it('keeps the configured layout for normal manga pages', () => {
    expect(layoutFor(mangaPages)).toBe('Two-page spread');
    expect(layoutFor(mangaPages, 'Single page')).toBe('Single page');
  });

  it('keeps a paged layout the reader chose for this title', () => {
    expect(layoutFor(strips, 'Two-page spread', 'Two-page spread')).toBe('Two-page spread');
    expect(layoutFor(strips, 'Single page', 'Single page')).toBe('Single page');
    // A title override that is itself the long strip is no reason to stay paged.
    expect(layoutFor(strips, 'Two-page spread', 'Long strip')).toBe('Long strip');
  });

  it('uses the 2.5 height-to-width threshold behind the old suggestion', () => {
    expect(
      layoutFor([
        [1000, 2500],
        [1000, 2500],
        [1000, 2500],
      ]),
    ).toBe('Long strip');
    expect(
      layoutFor([
        [1000, 2400],
        [1000, 2400],
        [1000, 2400],
      ]),
    ).toBe('Two-page spread');
  });

  it('waits for three pages, and one tall page among manga pages is not enough', () => {
    expect(looksLikeWebtoon(tally(strips.slice(0, 2)))).toBe(false);
    expect(looksLikeWebtoon(tally([[800, 9000], ...mangaPages.slice(0, 2)]))).toBe(false);
    expect(looksLikeWebtoon(tally([...strips.slice(0, 2), [1000, 1500]]))).toBe(true);
  });
});
