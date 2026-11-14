/**
 * Reader › Translate page, step one: finding and reading the Japanese text on a page.
 *
 * The text areas are always found on the device ({@link cropPageText}). Each is then read
 * by the server's manga-ocr when it has its models ({@link readPageTextWith}, local
 * translation), or else here by Tesseract (WASM) in a worker with its vertical-Japanese
 * model ({@link readPageText}), all served from this app's own `/ocr` folder
 * (scripts/copy-ocr-assets.mjs), so nothing loads from a CDN.
 *
 * Tesseract's own page layout finds nothing on a real manga page: the art around the
 * bubbles breaks it. So the text is found here first, and Tesseract reads one area at a
 * time as a single vertical block:
 *
 * - Speech bubbles and narration boxes: enclosed white areas with dark marks inside.
 *   Everything outside the bubble is whitened before reading, so art can't leak in.
 * - Text the bubble test misses (a bubble cut off by the page edge or running into the
 *   margin): clusters of glyph-sized marks set in solid white. Hatching and screentone
 *   are full of other lines and fail the "solid white" test.
 *
 * {@link findTextAreas} and {@link cleanText} are pure, and tested on synthetic pages.
 */
import type { ViewRect } from '@/lib/page-image';

/** A run of text on the page: where it is (fractions of the page) and what it says. */
export interface TextRegion extends ViewRect {
  text: string;
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/** Where text was found on the scan, and which scan pixels belong to it. */
export interface TextArea {
  box: Box;
  /** A bubble (or box) found whole, or loose text found by its glyphs. */
  kind: 'bubble' | 'loose';
  /** Whether a scan pixel is part of the area; anything else is whitened before reading. */
  keep: (x: number, y: number) => boolean;
}

/** Kana or kanji: what a Japanese speech bubble has and OCR noise on art mostly doesn't. */
const JAPANESE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/g;
/** Fewer Japanese characters than this is a sound effect or noise, not dialogue. */
const MIN_CHARACTERS = 2;
/** The longest side text is looked for at: enough to see glyphs, quick to label. */
export const SCAN_SIZE = 600;
/** The longest side the page is read at: big enough for small print. */
const OCR_MAX_SIDE = 2200;
/** Brighter than this (0–255) is paper: a bubble's inside, the margin. */
const PAPER = 200;
/** Glyph height the crops are scaled to: where Tesseract's model reads best. */
const TARGET_GLYPH = 48;
const CROP_PADDING = 24;
/** Readings less sure than this are dropped: a bubble, or text found by its glyphs. */
const MIN_CONFIDENCE = { bubble: 40, loose: 70 } as const;
/** Text whose tops are this close (a share of the page's height) is on one row. */
const ROW_TOLERANCE = 0.05;

/**
 * The text areas on a page, from its RGBA pixels at scan size (see {@link SCAN_SIZE}),
 * in scan pixels.
 */
export function findTextAreas(data: Uint8ClampedArray, width: number, height: number): TextArea[] {
  const w = width;
  const h = height;
  const size = w * h;
  if (w < 16 || h < 16 || data.length < size * 4) return [];
  const bright = new Uint8Array(size);
  for (let i = 0; i < size; i++)
    bright[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3 > PAPER ? 1 : 0;

  // Paper areas (4-connected), with their size, extent and whether they reach the edge.
  const label = new Int32Array(size).fill(-1);
  const areas: Array<Box & { area: number; touches: boolean }> = [];
  const stack: number[] = [];
  const flood = (
    start: number,
    same: (q: number) => boolean,
    labels: Int32Array,
    id: number,
    visit: (p: number, x: number, y: number) => void,
  ) => {
    const add = (q: number) => {
      if (labels[q] !== -1 || !same(q)) return;
      labels[q] = id;
      stack.push(q);
    };
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      visit(p, x, y);
      if (x > 0) add(p - 1);
      if (x < w - 1) add(p + 1);
      if (y > 0) add(p - w);
      if (y < h - 1) add(p + w);
    }
  };
  for (let start = 0; start < size; start++) {
    if (!bright[start] || label[start] !== -1) continue;
    const a = { x0: w, y0: h, x1: 0, y1: 0, area: 0, touches: false };
    flood(
      start,
      (q) => bright[q] === 1,
      label,
      areas.length,
      (_, x, y) => {
        a.area++;
        if (x < a.x0) a.x0 = x;
        if (x >= a.x1) a.x1 = x + 1;
        if (y < a.y0) a.y0 = y;
        if (y >= a.y1) a.y1 = y + 1;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) a.touches = true;
      },
    );
    areas.push(a);
  }

  const found: TextArea[] = [];
  const pageArea = size;
  const bubbleIds = new Set<number>();
  // Bubbles: closed, roughly solid paper areas of a plausible size, with some ink inside.
  areas.forEach((a, id) => {
    const bw = a.x1 - a.x0;
    const bh = a.y1 - a.y0;
    if (a.touches || a.area < pageArea * 0.004 || a.area > pageArea * 0.25) return;
    if (a.area / (bw * bh) < 0.45 || bw < 12 || bh < 12) return;
    // Each row's span of the bubble; anything in a span that isn't the bubble is ink.
    const spans: Array<[number, number]> = [];
    let ink = 0;
    let inside = 0;
    for (let y = a.y0; y < a.y1; y++) {
      let left = -1;
      let right = -1;
      for (let x = a.x0; x < a.x1; x++)
        if (label[y * w + x] === id) {
          if (left < 0) left = x;
          right = x;
        }
      spans.push([left, right]);
      if (left < 0) continue;
      for (let x = left; x <= right; x++) {
        inside++;
        if (label[y * w + x] !== id) ink++;
      }
    }
    const share = ink / Math.max(1, inside);
    if (share < 0.02 || share > 0.5) return;
    bubbleIds.add(id);
    found.push({
      box: { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 },
      kind: 'bubble',
      keep: (x, y) => {
        if (y < a.y0 || y >= a.y1) return false;
        const [left, right] = spans[y - a.y0];
        return left >= 0 && x >= left && x <= right;
      },
    });
  });

  // Loose text: dark marks of glyph size set in one large paper area that isn't a bubble.
  const dark = new Int32Array(size).fill(-1);
  const marks: Array<Box & { id: number; size: number; touches: boolean; paper: Set<number> }> = [];
  for (let start = 0; start < size; start++) {
    if (bright[start] || dark[start] !== -1) continue;
    const m = { id: marks.length, x0: w, y0: h, x1: 0, y1: 0, size: 0, touches: false };
    const paper = new Set<number>();
    flood(
      start,
      (q) => bright[q] === 0,
      dark,
      m.id,
      (p, x, y) => {
        m.size++;
        if (x < m.x0) m.x0 = x;
        if (x >= m.x1) m.x1 = x + 1;
        if (y < m.y0) m.y0 = y;
        if (y >= m.y1) m.y1 = y + 1;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) m.touches = true;
        if (x > 0 && bright[p - 1]) paper.add(label[p - 1]);
        if (x < w - 1 && bright[p + 1]) paper.add(label[p + 1]);
        if (y > 0 && bright[p - w]) paper.add(label[p - w]);
        if (y < h - 1 && bright[p + w]) paper.add(label[p + w]);
      },
    );
    marks.push({ ...m, paper });
  }
  const maxGlyph = Math.max(w, h) * 0.05;
  const gap = Math.max(w, h) * 0.02;
  // A glyph's other paper areas are its own counters (inside 口, the gaps in 待).
  const counter = (id: number) => areas[id].area <= maxGlyph * maxGlyph && !areas[id].touches;
  const glyphs: Array<(typeof marks)[number] & { home: number }> = [];
  for (const m of marks) {
    // Specks (screentone dots, noise) are too small to be part of a glyph.
    if (m.touches || m.size < 4 || m.x1 - m.x0 > maxGlyph || m.y1 - m.y0 > maxGlyph) continue;
    const homes = [...m.paper].filter((id) => !counter(id));
    if (homes.length !== 1 || bubbleIds.has(homes[0])) continue;
    glyphs.push({ ...m, home: homes[0] });
  }
  // Group glyphs of the same paper area within `gap` of each other; only marks in
  // neighbouring grid cells can be that close.
  const parent = glyphs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cell = maxGlyph + gap;
  const grid = new Map<string, number[]>();
  glyphs.forEach((g, i) => {
    const key = `${Math.floor(g.x0 / cell)},${Math.floor(g.y0 / cell)}`;
    grid.set(key, [...(grid.get(key) ?? []), i]);
  });
  glyphs.forEach((a, i) => {
    const cx = Math.floor(a.x0 / cell);
    const cy = Math.floor(a.y0 / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gy = cy - 1; gy <= cy + 1; gy++)
        for (const j of grid.get(`${gx},${gy}`) ?? []) {
          const b = glyphs[j];
          if (j <= i || a.home !== b.home) continue;
          const dx = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
          const dy = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
          if (dx <= gap && dy <= gap) parent[find(i)] = find(j);
        }
  });
  const groups = new Map<number, typeof glyphs>();
  glyphs.forEach((g, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), g]));

  // Dark pixels in any rectangle in constant time, to throw out hatching cheaply.
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0, row = 0; x < w; x++) {
      row += bright[y * w + x] ? 0 : 1;
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  const darkIn = (b: Box) =>
    sat[b.y1 * (w + 1) + b.x1] -
    sat[b.y0 * (w + 1) + b.x1] -
    sat[b.y1 * (w + 1) + b.x0] +
    sat[b.y0 * (w + 1) + b.x0];
  for (const group of groups.values()) {
    if (group.length < 4) continue;
    const home = group[0].home;
    const ids = new Set(group.map((g) => g.id));
    const pad = Math.round(gap);
    const box = {
      x0: Math.max(0, Math.min(...group.map((g) => g.x0)) - pad),
      y0: Math.max(0, Math.min(...group.map((g) => g.y0)) - pad),
      x1: Math.min(w, Math.max(...group.map((g) => g.x1)) + pad),
      y1: Math.min(h, Math.max(...group.map((g) => g.y1)) + pad),
    };
    const boxArea = (box.x1 - box.x0) * (box.y1 - box.y0);
    // Smaller is a page number or a logo; larger is no single piece of dialogue.
    if (boxArea < (Math.max(w, h) * 0.04) ** 2 || boxArea > pageArea * 0.12) continue;
    // Text sits in solid paper: around it is only its own paper and its own glyphs.
    const others = darkIn(box) - group.reduce((sum, g) => sum + g.size, 0);
    if (others / boxArea > 0.1) continue;
    const keep = (x: number, y: number) => {
      const q = y * w + x;
      if (bright[q]) return label[q] === home || counter(label[q]);
      // A speck in the same paper stays: the dakuten of が, the circle of ぱ.
      const mark = marks[dark[q]];
      return ids.has(mark.id) || (mark.size < 4 && mark.paper.has(home));
    };
    let own = 0;
    for (let y = box.y0; y < box.y1; y++)
      for (let x = box.x0; x < box.x1; x++) if (keep(x, y)) own++;
    if (own / boxArea < 0.9) continue;
    found.push({ box, kind: 'loose', keep });
  }
  return found;
}

/**
 * What Tesseract read, made fit to translate: no spaces (it puts them between Japanese
 * characters), no stray Latin letters or ASCII brackets (noise, on a Japanese-only
 * reading; Japanese dialogue uses full-width brackets), and its usual misreadings of
 * vertical punctuation put right.
 */
export function cleanText(raw: string): string {
  return (
    raw
      .replace(/\s+/g, '')
      .replace(/[A-Za-z_|\\/()[\]{}<>=+*^`'"]+/g, '')
      // A vertical ellipsis comes out as colons or dots.
      .replace(/[:：.・]{2,}/g, '…')
      // A vertical question mark after Japanese comes out as a 7 or a 2.
      .replace(/(?<=[぀-ヿ㐀-鿿])[27](?=$|[…！？!?」』])/g, '？')
  );
}

/** Reading order: columns starting at about the same height are one row, read right to
 * left; rows top to bottom. */
export function inReadingOrder<T extends ViewRect>(regions: readonly T[]): T[] {
  return [...regions].sort((a, b) => (Math.abs(a.y - b.y) < ROW_TOLERANCE ? b.x - a.x : a.y - b.y));
}

type Grey = { pixels: Uint8ClampedArray; width: number; height: number };

function otsu(pixels: Uint8ClampedArray): number {
  const histogram = new Array<number>(256).fill(0);
  for (const value of pixels) histogram[value]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumBelow = 0;
  let below = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    below += histogram[i];
    if (!below) continue;
    const above = pixels.length - below;
    if (!above) break;
    sumBelow += i * histogram[i];
    const between = below * above * (sumBelow / below - (sum - sumBelow) / above) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/** The ink's extent in a crop, and its typical glyph size: the median width of the ink
 * columns (vertical text sits in columns one glyph wide). */
function measureInk({ pixels, width, height }: Grey) {
  const threshold = otsu(pixels);
  const columns = new Array<number>(width).fill(0);
  const ink = { x0: width, y0: height, x1: 0, y1: 0 };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (pixels[y * width + x] <= threshold) {
        columns[x]++;
        if (x < ink.x0) ink.x0 = x;
        if (x >= ink.x1) ink.x1 = x + 1;
        if (y < ink.y0) ink.y0 = y;
        if (y >= ink.y1) ink.y1 = y + 1;
      }
  const runs: number[] = [];
  let run = 0;
  for (const count of [...columns, 0]) {
    if (count > 0) run++;
    else if (run) {
      if (run > 3) runs.push(run);
      run = 0;
    }
  }
  runs.sort((a, b) => a - b);
  return { glyph: runs.length ? runs[Math.floor(runs.length / 2)] : 30, ink };
}

/** The crop as Tesseract reads it best: grey, glyphs about {@link TARGET_GLYPH} pixels,
 * on a white margin. */
function cropCanvas({ pixels, width, height }: Grey, glyph: number): HTMLCanvasElement {
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext('2d')!;
  const image = sourceContext.createImageData(width, height);
  for (let i = 0; i < pixels.length; i++) {
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = pixels[i];
    image.data[i * 4 + 3] = 255;
  }
  sourceContext.putImageData(image, 0, 0);
  const scale = Math.max(1, Math.min(4, TARGET_GLYPH / Math.max(8, glyph)));
  const out = document.createElement('canvas');
  out.width = Math.round(width * scale) + CROP_PADDING * 2;
  out.height = Math.round(height * scale) + CROP_PADDING * 2;
  const context = out.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, out.width, out.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, CROP_PADDING, CROP_PADDING, width * scale, height * scale);
  return out;
}

type TesseractWorker = Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>>;
let worker: Promise<TesseractWorker> | null = null;

function ocrWorker(): Promise<TesseractWorker> {
  worker ??= import('tesseract.js')
    .then(async ({ createWorker, OEM, PSM }) => {
      const at = (path: string) => new URL(path, window.location.origin).href;
      const created = await createWorker('jpn_vert', OEM.LSTM_ONLY, {
        workerPath: at('/ocr/worker.min.js'),
        corePath: at('/ocr/core'),
        langPath: at('/ocr/lang'),
        // A blob: worker would need the desktop app's CSP to allow blob: scripts.
        workerBlobURL: false,
        gzip: true,
      });
      // Each crop is one bubble: a single block of vertical text.
      await created.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK_VERT_TEXT });
      return created;
    })
    .catch((error) => {
      worker = null;
      throw error;
    });
  return worker;
}

/** Loads the page again with CORS so its pixels can be read. */
function loadPixels(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'use-credentials';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The page's image couldn't be read"));
    img.src = url;
  });
}

function pixelsOf(img: HTMLImageElement, longest: number) {
  const scale = Math.min(1, longest / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error("The page's image couldn't be read");
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  // Throws on a cross-origin image the server didn't allow.
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height };
}

/** One text area cut out of the page, everything around it whitened, ready to read. */
export interface PageCrop {
  kind: TextArea['kind'];
  grey: Grey;
  /** Typical glyph size in the crop, in pixels. */
  glyph: number;
  /** Where its translation goes, as fractions of the page. */
  region: ViewRect;
}

/** The text areas on the page at `url`, each cut out, in the order they were found. */
export async function cropPageText(url: string): Promise<PageCrop[]> {
  const img = await loadPixels(url);
  const scan = pixelsOf(img, SCAN_SIZE);
  const areas = findTextAreas(scan.data, scan.width, scan.height);
  if (areas.length === 0) return [];
  const page = pixelsOf(img, OCR_MAX_SIDE);
  // Page pixels per scan pixel.
  const ratio = page.width / scan.width;
  const crops: PageCrop[] = [];
  for (const area of areas) {
    const x0 = Math.floor(area.box.x0 * ratio);
    const y0 = Math.floor(area.box.y0 * ratio);
    const width = Math.min(page.width, Math.ceil(area.box.x1 * ratio)) - x0;
    const height = Math.min(page.height, Math.ceil(area.box.y1 * ratio)) - y0;
    const pixels = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = Math.min(scan.width - 1, Math.floor((x0 + x) / ratio));
        const sy = Math.min(scan.height - 1, Math.floor((y0 + y) / ratio));
        const i = ((y0 + y) * page.width + x0 + x) * 4;
        pixels[y * width + x] = area.keep(sx, sy)
          ? 0.299 * page.data[i] + 0.587 * page.data[i + 1] + 0.114 * page.data[i + 2]
          : 255;
      }
    const grey = { pixels, width, height };
    const { glyph, ink } = measureInk(grey);
    if (ink.x1 <= ink.x0) continue;
    // The translation goes over the bubble's inside (an ellipse's inner rectangle), and
    // always over all of the ink.
    const inset = area.kind === 'bubble' ? 0.15 : 0;
    const box = {
      x0: Math.min(x0 + width * inset, x0 + ink.x0),
      y0: Math.min(y0 + height * inset, y0 + ink.y0),
      x1: Math.max(x0 + width * (1 - inset), x0 + ink.x1),
      y1: Math.max(y0 + height * (1 - inset), y0 + ink.y1),
    };
    crops.push({
      kind: area.kind,
      grey,
      glyph,
      region: {
        x: box.x0 / page.width,
        y: box.y0 / page.height,
        w: (box.x1 - box.x0) / page.width,
        h: (box.y1 - box.y0) / page.height,
      },
    });
  }
  return crops;
}

/** Dialogue rather than a sound effect or noise: enough kana or kanji. */
export function isDialogue(text: string): boolean {
  return (text.match(JAPANESE)?.length ?? 0) >= MIN_CHARACTERS;
}

/** The longest side a crop is sent to the server at: the model reads it at 224px. */
const SERVER_CROP_SIDE = 448;

/** A crop as the server's manga-ocr takes it: grey on white, PNG, base64. */
export async function cropAsPng({ grey }: PageCrop): Promise<string> {
  const scale = Math.min(1, SERVER_CROP_SIDE / Math.max(grey.width, grey.height));
  const source = document.createElement('canvas');
  source.width = grey.width;
  source.height = grey.height;
  const sourceContext = source.getContext('2d')!;
  const image = sourceContext.createImageData(grey.width, grey.height);
  for (let i = 0; i < grey.pixels.length; i++) {
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = grey.pixels[i];
    image.data[i * 4 + 3] = 255;
  }
  sourceContext.putImageData(image, 0, 0);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(grey.width * scale));
  out.height = Math.max(1, Math.round(grey.height * scale));
  const context = out.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, out.width, out.height);
  return out.toDataURL('image/png').slice('data:image/png;base64,'.length);
}

/** Reads the Japanese text on the page at `url` on the device (Tesseract), in reading order. */
export async function readPageText(url: string): Promise<TextRegion[]> {
  const crops = await cropPageText(url);
  if (crops.length === 0) return [];
  const ocr = await ocrWorker();
  const regions: TextRegion[] = [];
  for (const crop of crops) {
    const { data } = await ocr.recognize(cropCanvas(crop.grey, crop.glyph), {}, { blocks: true });
    const paragraphs = (data.blocks ?? []).flatMap((block) => block.paragraphs);
    const characters = paragraphs.reduce((sum, p) => sum + p.text.length, 0);
    const confidence = characters
      ? paragraphs.reduce((sum, p) => sum + p.confidence * p.text.length, 0) / characters
      : 0;
    const text = cleanText(paragraphs.map((p) => p.text).join(''));
    if (confidence < MIN_CONFIDENCE[crop.kind]) continue;
    if (!isDialogue(text)) continue;
    regions.push({ text, ...crop.region });
  }
  return inReadingOrder(withoutOverlaps(regions));
}

/**
 * Reads the Japanese text on the page at `url` with the server's manga-ocr, in reading
 * order. `read` takes the page's crops (PNG, base64) and returns their text in order.
 */
export async function readPageTextWith(
  url: string,
  read: (images: string[]) => Promise<string[]>,
): Promise<TextRegion[]> {
  const crops = (await cropPageText(url)).slice(0, 60);
  if (crops.length === 0) return [];
  const texts = await read(await Promise.all(crops.map(cropAsPng)));
  const regions: TextRegion[] = [];
  crops.forEach((crop, index) => {
    // manga-ocr's own output: already tidy, unlike Tesseract's (see cleanText).
    const text = (texts[index] ?? '').trim();
    if (isDialogue(text)) regions.push({ text, ...crop.region });
  });
  return inReadingOrder(withoutOverlaps(regions));
}

/**
 * One reading per bubble: the same text can be found twice, as a bubble and as loose text
 * around it, and two overlays on one spot show one through the other. A region mostly
 * inside a larger one is dropped.
 */
export function withoutOverlaps<T extends ViewRect>(regions: readonly T[]): T[] {
  const area = (r: ViewRect) => r.w * r.h;
  const bySize = [...regions].sort((a, b) => area(b) - area(a));
  const kept: T[] = [];
  for (const region of bySize) {
    const covered = kept.some((other) => {
      const w = Math.min(region.x + region.w, other.x + other.w) - Math.max(region.x, other.x);
      const h = Math.min(region.y + region.h, other.y + other.h) - Math.max(region.y, other.y);
      return w > 0 && h > 0 && (w * h) / area(region) > 0.5;
    });
    if (!covered) kept.push(region);
  }
  return kept;
}

/** The longest side a whole page is sent at: the detector reads it at 640px, and the crops
 * manga-ocr reads come from this copy, so small print needs some room. */
const SERVER_PAGE_SIDE = 1600;

/** The page as the server's text detector takes it: JPEG, base64, at most 1600px long. */
async function pageAsJpeg(url: string): Promise<string> {
  const img = await loadPixels(url);
  const scale = Math.min(1, SERVER_PAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error("The page's image couldn't be read");
  context.imageSmoothingQuality = 'high';
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  // Throws on a cross-origin image the server didn't allow, as reading its pixels does.
  return canvas.toDataURL('image/jpeg', 0.9).slice('data:image/jpeg;base64,'.length);
}

/**
 * Reads the Japanese text on the page at `url` with the server's own models: its text
 * detector finds every bubble and piece of free text, and manga-ocr reads them. `read`
 * sends the page (JPEG, base64) and returns the regions, in page fractions.
 */
export async function readPageTextOnServer(
  url: string,
  read: (image: string) => Promise<TextRegion[]>,
): Promise<TextRegion[]> {
  const regions = (await read(await pageAsJpeg(url)))
    .map((region) => ({ ...region, text: region.text.trim() }))
    .filter((region) => isDialogue(region.text));
  return inReadingOrder(withoutOverlaps(regions));
}
