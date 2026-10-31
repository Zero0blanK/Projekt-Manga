import { describe, expect, it } from 'vitest';
import {
  buildReaderUnits,
  colorFilterStyle,
  findContentBounds,
  halfOf,
  isWidePage,
  pageImageFileName,
  readerTintColor,
  tintOpacity,
} from '@/lib/page-image';

/** A `width`×`height` image filled with `border`, with a dark box from (x0,y0) to (x1,y1). */
function page(
  width: number,
  height: number,
  box: [number, number, number, number] | null,
  border = 255,
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inBox = box && x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
      const value = inBox ? (border > 128 ? 20 : 230) : border;
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  return data;
}

describe('reader colour filters', () => {
  it('maps each filter to CSS and ignores unknown values', () => {
    expect(colorFilterStyle('None')).toBeUndefined();
    expect(colorFilterStyle('Grayscale')).toBe('grayscale(1)');
    expect(colorFilterStyle('Invert')).toContain('invert(1)');
    expect(colorFilterStyle('bogus')).toBeUndefined();
  });

  it('resolves tints and clamps their strength', () => {
    expect(readerTintColor('None')).toBeUndefined();
    expect(readerTintColor('Amber')).toMatch(/^#[0-9a-f]{6}$/);
    expect(readerTintColor('bogus')).toBeUndefined();
    expect(tintOpacity(25)).toBe(0.25);
    expect(tintOpacity(100)).toBe(0.6);
    expect(tintOpacity(0)).toBe(0.1);
    expect(tintOpacity(Number.NaN)).toBe(0.25);
  });
});

describe('border cropping', () => {
  it('finds the content inside a white margin', () => {
    const bounds = findContentBounds(page(100, 200, [10, 20, 90, 180]), 100, 200);
    expect(bounds.x).toBeCloseTo(0.1);
    expect(bounds.y).toBeCloseTo(0.1);
    expect(bounds.w).toBeCloseTo(0.8);
    expect(bounds.h).toBeCloseTo(0.8);
  });

  it('finds the content inside a black margin, and keeps the height in the long strip', () => {
    const data = page(100, 200, [10, 20, 90, 180], 0);
    expect(findContentBounds(data, 100, 200).x).toBeCloseTo(0.1);
    const strip = findContentBounds(data, 100, 200, { horizontalOnly: true });
    expect(strip).toMatchObject({ y: 0, h: 1 });
    expect(strip.w).toBeCloseTo(0.8);
  });

  it('leaves full-bleed, blank, mostly empty and barely-margined pages alone', () => {
    const full = { x: 0, y: 0, w: 1, h: 1 };
    expect(findContentBounds(page(100, 100, [0, 0, 100, 100]), 100, 100)).toEqual(full);
    expect(findContentBounds(page(100, 100, null), 100, 100)).toEqual(full);
    expect(findContentBounds(page(100, 100, [45, 45, 55, 55]), 100, 100)).toEqual(full);
    // Art bleeding off one corner: the corners disagree, so there is no border.
    expect(findContentBounds(page(100, 100, [0, 0, 60, 60]), 100, 100)).toEqual(full);
    expect(findContentBounds(page(200, 200, [1, 1, 199, 199]), 200, 200)).toEqual(full);
  });

  it('ignores a speck of dust in the margin', () => {
    const data = page(100, 100, [10, 10, 90, 90]);
    data.set([0, 0, 0, 255], (50 * 100 + 3) * 4);
    expect(findContentBounds(data, 100, 100).x).toBeCloseTo(0.1);
  });
});

describe('splitting double pages', () => {
  it('recognises spreads and halves a view', () => {
    expect(isWidePage(1600, 1100)).toBe(true);
    expect(isWidePage(800, 1100)).toBe(false);
    expect(halfOf({ x: 0.1, y: 0, w: 0.8, h: 1 }, 'right')).toEqual({ x: 0.5, y: 0, w: 0.4, h: 1 });
  });

  const base = { totalPages: 4, offsetFirstPage: false, widePages: new Set([2]), rtl: false };

  it('splits wide pages into halves in reading order, keeping source page numbers', () => {
    expect(buildReaderUnits({ ...base, pagesPerView: 1, splitWide: true })).toEqual([
      { pages: [1] },
      { pages: [2], half: 'left' },
      { pages: [2], half: 'right' },
      { pages: [3] },
      { pages: [4] },
    ]);
    const rtl = buildReaderUnits({ ...base, pagesPerView: 1, splitWide: true, rtl: true });
    expect(rtl.slice(1, 3).map((unit) => unit.half)).toEqual(['right', 'left']);
  });

  it('does not split when the setting is off or in two-page mode', () => {
    expect(buildReaderUnits({ ...base, pagesPerView: 1, splitWide: false })).toHaveLength(4);
    // A spread is shown alone in two-page mode, and the pages around it pair up.
    expect(buildReaderUnits({ ...base, pagesPerView: 2, splitWide: true })).toEqual([
      { pages: [1] },
      { pages: [2] },
      { pages: [3, 4] },
    ]);
    expect(
      buildReaderUnits({ ...base, pagesPerView: 2, splitWide: false, offsetFirstPage: true }),
    ).toEqual([{ pages: [1] }, { pages: [2] }, { pages: [3, 4] }]);
    expect(
      buildReaderUnits({ ...base, widePages: new Set(), pagesPerView: 2, splitWide: false }),
    ).toEqual([{ pages: [1, 2] }, { pages: [3, 4] }]);
  });

  it('turns a double page on its side in single-page mode, unless it is split', () => {
    expect(
      buildReaderUnits({ ...base, pagesPerView: 1, splitWide: false, rotateWide: true })[1],
    ).toEqual({ pages: [2], rotate: true });
    expect(
      buildReaderUnits({ ...base, pagesPerView: 1, splitWide: true, rotateWide: true })[1],
    ).toEqual({ pages: [2], half: 'left' });
  });
});

describe('saved page names', () => {
  it('strips characters file systems reject', () => {
    expect(pageImageFileName('Re:Zero / Part "2"? \\ x', 12, 4)).toBe(
      'Re Zero Part 2 x - ch12 - p004',
    );
    expect(pageImageFileName('***', 1, 1)).toBe('page - ch1 - p001');
  });
});
