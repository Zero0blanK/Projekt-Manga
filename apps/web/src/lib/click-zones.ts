/**
 * Where on the page a click lands (Settings › Reader › Click zones). Each layout splits the
 * reader into the same three zones the per-zone actions are set for (left, center and
 * right), so changing the layout never loses those choices.
 */

export const ZONE_LAYOUTS = ['Thirds', 'L-shape', 'Kindle', 'Edges', 'Off'] as const;
export type ZoneLayout = (typeof ZONE_LAYOUTS)[number];
export type Zone = 'left' | 'center' | 'right';
export const READER_ZONE_LAYOUT = 'readerZoneLayout';

/** Shown under the layout setting. */
export const ZONE_LAYOUT_HINTS: Record<ZoneLayout, string> = {
  Thirds: 'Three columns',
  'L-shape': 'Top and left go one way, bottom and right the other',
  Kindle: 'The top strip shows controls, the left third goes back',
  Edges: 'Narrow strips at each side turn pages, the rest shows controls',
  Off: 'Clicking the page does nothing; use the keyboard or the arrows',
};

/** How wide the side strips of the "Edges" layout are. */
const EDGE = 0.15;

/**
 * The zone at (x, y), both fractions of the reader's size from its top-left corner, or
 * null where the layout has no zone (Off).
 */
export function zoneAt(x: number, y: number, layout: string): Zone | null {
  const column: Zone = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
  switch (layout) {
    case 'L-shape':
      // Mihon's L: the top row and the left of the middle row are one zone, the bottom
      // row and the right of the middle row the other.
      if (y < 1 / 3) return 'left';
      if (y > 2 / 3) return 'right';
      return column;
    case 'Kindle':
      if (y < 1 / 3) return 'center';
      return x < 1 / 3 ? 'left' : 'right';
    case 'Edges':
      return x < EDGE ? 'left' : x > 1 - EDGE ? 'right' : 'center';
    case 'Off':
      return null;
    default:
      return column;
  }
}

/** A coarse picture of a layout for its settings preview: `rows`×`cols` cells, each the
 * zone at that cell's centre. */
export function zoneGrid(layout: string, rows = 6, cols = 6): (Zone | null)[][] {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) =>
      zoneAt((col + 0.5) / cols, (row + 0.5) / rows, layout),
    ),
  );
}
