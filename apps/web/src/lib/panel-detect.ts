/**
 * Guided view (Settings › Reader › Guided view): finding a page's panels so the reader can
 * show them one at a time. A recursive "XY cut" over the pixels: the page is split at blank
 * rows (gutters running across it), each strip at blank columns, and each piece again, a
 * few levels deep. No machine learning, so it handles the common grid layouts and gives
 * up on art that bleeds across gutters, where the reader then shows the whole page.
 *
 * Pure apart from {@link measurePanels}, so it can be tested on synthetic pixels.
 */
import type { ViewRect } from '@/lib/page-image';

export const READER_GUIDED_VIEW = 'readerGuidedView';

/** How far a pixel may stray from the gutter colour and still be gutter (JPEG noise). */
const TOLERANCE = 40;
/** A line counts as gutter when this share of it is gutter-coloured (a speck, a crossing
 * speech-bubble tail). */
const GUTTER_SHARE = 0.985;
/** Gutters thinner than this many scan pixels are ignored (ink lines inside a panel). */
const MIN_GUTTER = 2;
/** Pieces smaller than this share of the page are not panels (a page number, a logo). */
const MIN_PANEL_AREA = 0.02;
const MAX_DEPTH = 4;
const MAX_PANELS = 24;

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * The page's panels in reading order, as fractions of the page: top to bottom, and across
 * each strip right to left when `rtl`. Fewer than two panels returns an empty list: the
 * page has no layout guided view can follow.
 */
export function detectPanels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rtl: boolean,
): ViewRect[] {
  if (width < 16 || height < 16 || data.length < width * height * 4) return [];
  const at = (x: number, y: number) => (y * width + x) * 4;
  const lum = (i: number) => (data[i] + data[i + 1] + data[i + 2]) / 3;
  // The gutter colour: whichever of white or black the page's corners are.
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const cornerLum = corners.reduce((sum, i) => sum + lum(i), 0) / 4;
  const gutter = cornerLum > 128 ? 255 : 0;
  const isGutter = (x: number, y: number) => Math.abs(lum(at(x, y)) - gutter) <= TOLERANCE;

  const rowIsGutter = (y: number, box: Box) => {
    let hits = 0;
    for (let x = box.x0; x < box.x1; x++) if (isGutter(x, y)) hits++;
    return hits >= (box.x1 - box.x0) * GUTTER_SHARE;
  };
  const colIsGutter = (x: number, box: Box) => {
    let hits = 0;
    for (let y = box.y0; y < box.y1; y++) if (isGutter(x, y)) hits++;
    return hits >= (box.y1 - box.y0) * GUTTER_SHARE;
  };

  /** Runs of non-gutter lines along one axis, split where a gutter is wide enough. */
  const segments = (from: number, to: number, gutterAt: (line: number) => boolean) => {
    const runs: Array<[number, number]> = [];
    let start = -1;
    let blank = 0;
    for (let line = from; line < to; line++) {
      if (gutterAt(line)) {
        blank++;
        if (start !== -1 && blank >= MIN_GUTTER) {
          runs.push([start, line - blank + 1]);
          start = -1;
        }
      } else {
        if (start === -1) start = line;
        blank = 0;
      }
    }
    if (start !== -1) runs.push([start, to - (blank > 0 ? blank : 0)]);
    return runs;
  };

  const pageArea = width * height;
  const panels: Box[] = [];
  /** Splits `box` along one axis; a piece that won't split that way is tried along the
   * other once, and is a panel when neither splits it. */
  const cut = (box: Box, depth: number, horizontal: boolean, triedOther: boolean) => {
    if (panels.length >= MAX_PANELS) return;
    const runs = horizontal
      ? segments(box.y0, box.y1, (y) => rowIsGutter(y, box))
      : segments(box.x0, box.x1, (x) => colIsGutter(x, box));
    const pieces = runs
      .map(([a, b]): Box => (horizontal ? { ...box, y0: a, y1: b } : { ...box, x0: a, x1: b }))
      .filter(
        (piece) => (piece.x1 - piece.x0) * (piece.y1 - piece.y0) >= pageArea * MIN_PANEL_AREA,
      );
    if (!horizontal && rtl) pieces.reverse();
    // Nothing big enough in here (a page number, a speck in the margin): no panel.
    if (pieces.length === 0) return;
    if (pieces.length === 1) {
      const piece = pieces[0];
      if (!triedOther) cut(piece, depth, !horizontal, true);
      else panels.push(piece);
      return;
    }
    for (const piece of pieces) {
      if (depth < MAX_DEPTH) cut(piece, depth + 1, !horizontal, false);
      else panels.push(piece);
    }
  };
  cut({ x0: 0, y0: 0, x1: width, y1: height }, 0, true, false);

  if (panels.length < 2) return [];
  return panels.map((box) => ({
    x: box.x0 / width,
    y: box.y0 / height,
    w: (box.x1 - box.x0) / width,
    h: (box.y1 - box.y0) / height,
  }));
}

/** The longest side the panel scan samples at: gutters survive the downscale. */
const SCAN_SIZE = 480;
const panelCache = new Map<string, ViewRect[]>();

/**
 * The panels of a loaded `<img>`, scanned on an offscreen canvas and cached by URL. An
 * image whose pixels can't be read (a cross-origin image the server didn't allow) has no
 * panels, so the reader shows it whole.
 */
export function measurePanels(img: HTMLImageElement, rtl: boolean): ViewRect[] {
  const key = `${rtl ? 'r' : 'l'}:${img.currentSrc || img.src}`;
  const cached = panelCache.get(key);
  if (cached) return cached;
  let result: ViewRect[] = [];
  try {
    const scale = Math.min(1, SCAN_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.drawImage(img, 0, 0, width, height);
      result = detectPanels(context.getImageData(0, 0, width, height).data, width, height, rtl);
    }
  } catch {
    // Tainted canvas: no panels.
  }
  if (panelCache.size > 500) panelCache.clear();
  panelCache.set(key, result);
  return result;
}
