import { describe, expect, it } from 'vitest';
import { detectPanels } from '@/lib/panel-detect';

/** A white page with grey-filled panels at the given pixel boxes. */
function page(width: number, height: number, boxes: Array<[number, number, number, number]>) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1] of boxes)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) data.set([90, 90, 90, 255], (y * width + x) * 4);
  return data;
}

const round = (rects: Array<{ x: number; y: number; w: number; h: number }>) =>
  rects.map((r) => [r.x, r.y, r.w, r.h].map((n) => Math.round(n * 100) / 100));

describe('panel detection', () => {
  // Two strips: two panels side by side on top, one wide panel below.
  const layout: Array<[number, number, number, number]> = [
    [5, 5, 48, 45],
    [52, 5, 95, 45],
    [5, 55, 95, 95],
  ];

  it('finds a grid in reading order, right to left for manga', () => {
    const rects = detectPanels(page(100, 100, layout), 100, 100, true);
    expect(round(rects)).toEqual([
      [0.52, 0.05, 0.43, 0.4],
      [0.05, 0.05, 0.43, 0.4],
      [0.05, 0.55, 0.9, 0.4],
    ]);
  });

  it('reads left to right when the title does', () => {
    const rects = detectPanels(page(100, 100, layout), 100, 100, false);
    expect(round(rects)[0]).toEqual([0.05, 0.05, 0.43, 0.4]);
  });

  it('gives up on a single splash page, so the whole page shows', () => {
    expect(detectPanels(page(100, 100, [[5, 5, 95, 95]]), 100, 100, true)).toEqual([]);
    expect(detectPanels(page(100, 100, []), 100, 100, true)).toEqual([]);
  });

  it('ignores specks too small to be panels', () => {
    const rects = detectPanels(page(100, 100, [...layout, [97, 97, 99, 99]]), 100, 100, true);
    expect(rects).toHaveLength(3);
  });
});
