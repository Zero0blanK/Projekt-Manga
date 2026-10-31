/**
 * Reader image tools (Settings › Reader › Image): colour filters, border cropping and
 * splitting wide double pages. The maths lives here, apart from the components, so it can
 * be tested without a browser's canvas.
 */

export const COLOR_FILTERS = ['None', 'Grayscale', 'Sepia', 'Invert'] as const;
export type ColorFilter = (typeof COLOR_FILTERS)[number];

export const READER_COLOR_FILTER = 'readerColorFilter';
export const READER_CROP_BORDERS = 'readerCropBorders';
export const READER_SPLIT_WIDE = 'readerSplitWidePages';
/** Single-page mode: a double page turned on its side to use the screen's height. */
export const READER_ROTATE_WIDE = 'readerRotateWidePages';
/** Two-page mode: swap which page of a spread is on which side. */
export const READER_SWAP_SPREAD = 'readerSwapSpreadOrder';
/** Pages this much taller than wide make a chapter look like a webtoon. */
export const TALL_RATIO = 2.5;
export const isTallPage = (width: number, height: number) =>
  width > 0 && height > 0 && height >= width * TALL_RATIO;

/** The CSS `filter` for a colour filter setting, or undefined for none (or an unknown
 * stored value, so a bad setting shows the page as it is). */
export function colorFilterStyle(filter: string): string | undefined {
  switch (filter) {
    case 'Grayscale':
      return 'grayscale(1)';
    case 'Sepia':
      return 'sepia(0.6)';
    case 'Invert':
      // hue-rotate keeps colour pages' hues roughly right after the inversion.
      return 'invert(1) hue-rotate(180deg)';
    default:
      return undefined;
  }
}

/** Tints laid over the reader, from Settings › Reader › Tint. Multiplied into the page, so
 * white paper takes the colour and black ink stays black. */
export const READER_TINTS = [
  { label: 'None', value: '' },
  { label: 'Warm', value: '#ffb36b' },
  { label: 'Amber', value: '#ff9a1f' },
  { label: 'Red', value: '#ff4a3d' },
  { label: 'Green', value: '#7fd18b' },
  { label: 'Blue', value: '#6fa8ff' },
  /** Any colour, from Settings › Reader › Custom tint colour. */
  { label: 'Custom', value: '' },
] as const;
export const READER_TINT_CUSTOM = 'readerTintCustomColor';
export const DEFAULT_TINT_CUSTOM = '#c08bff';
export const READER_TINT_BLEND = 'readerTintBlend';
export const TINT_BLENDS = ['Multiply', 'Screen', 'Overlay'] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export const READER_TINT = 'readerTint';
export const READER_TINT_STRENGTH = 'readerTintStrength';
export const TINT_STRENGTH_MIN = 10;
export const TINT_STRENGTH_MAX = 60;
export const DEFAULT_TINT_STRENGTH = 25;

/** The overlay colour for a tint setting, or undefined for none or an unknown value.
 * "Custom" uses `custom` when it is a plain #rrggbb colour. */
export function readerTintColor(label: string, custom?: string): string | undefined {
  if (label === 'Custom') return custom && HEX_COLOR.test(custom) ? custom : undefined;
  return READER_TINTS.find((tint) => tint.label === label)?.value || undefined;
}

/** The CSS blend mode for a tint blend setting; multiply for anything unknown. */
export function tintBlendMode(blend: string): 'multiply' | 'screen' | 'overlay' {
  return blend === 'Screen' ? 'screen' : blend === 'Overlay' ? 'overlay' : 'multiply';
}

/** A stored strength as an opacity, clamped so a bad value can't hide the page. */
export function tintOpacity(strength: number): number {
  const value = Number.isFinite(strength) ? strength : DEFAULT_TINT_STRENGTH;
  return Math.min(TINT_STRENGTH_MAX, Math.max(TINT_STRENGTH_MIN, value)) / 100;
}

/** The part of an image to show, as fractions of its natural size. */
export type ViewRect = { x: number; y: number; w: number; h: number };
export const FULL_VIEW: ViewRect = { x: 0, y: 0, w: 1, h: 1 };

/** A page this much wider than tall is a double-page spread. */
export const WIDE_RATIO = 1.2;
export const isWidePage = (width: number, height: number) =>
  width > 0 && height > 0 && width > height * WIDE_RATIO;

/** How far a pixel's channels may stray from the border colour and still count as border:
 * scans are rarely pure white, and JPEG noise sits around the edges. */
const BORDER_TOLERANCE = 28;
/** Margins thinner than this (as a fraction) aren't worth cropping, and a "content" box
 * smaller than this is a page that is mostly blank, where cropping would zoom into noise. */
const MIN_MARGIN = 0.01;
const MIN_CONTENT = 0.25;

/**
 * Finds the content inside a uniform border, white or black, in RGBA pixel data.
 *
 * The border colour is taken from the four corners; when they disagree the page has no
 * border (art bleeds to the edge) and the whole image is returned. `horizontalOnly` keeps
 * the full height, for the long strip, where top and bottom margins are the gaps between
 * panels that the artist drew on purpose.
 */
export function findContentBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  { horizontalOnly = false }: { horizontalOnly?: boolean } = {},
): ViewRect {
  if (width < 4 || height < 4 || data.length < width * height * 4) return FULL_VIEW;
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const lum = (i: number) => (data[i] + data[i + 1] + data[i + 2]) / 3;
  const border = lum(corners[0]);
  if (!(border > 255 - BORDER_TOLERANCE || border < BORDER_TOLERANCE)) return FULL_VIEW;
  if (corners.some((i) => Math.abs(lum(i) - border) > BORDER_TOLERANCE)) return FULL_VIEW;

  const isBorder = (x: number, y: number) => {
    const i = at(x, y);
    return (
      Math.abs(data[i] - border) <= BORDER_TOLERANCE &&
      Math.abs(data[i + 1] - border) <= BORDER_TOLERANCE &&
      Math.abs(data[i + 2] - border) <= BORDER_TOLERANCE
    );
  };
  // A row or column is content once more than 1% of it differs, so a stray speck of
  // dust in the margin doesn't stop the crop.
  const columnHasContent = (x: number) => {
    let hits = 0;
    for (let y = 0; y < height; y++)
      if (!isBorder(x, y) && ++hits > Math.max(1, height * 0.01)) return true;
    return false;
  };
  const rowHasContent = (y: number) => {
    let hits = 0;
    for (let x = 0; x < width; x++)
      if (!isBorder(x, y) && ++hits > Math.max(1, width * 0.01)) return true;
    return false;
  };

  let left = 0;
  while (left < width && !columnHasContent(left)) left++;
  if (left === width) return FULL_VIEW; // blank page
  let right = width - 1;
  while (right > left && !columnHasContent(right)) right--;
  let top = 0;
  let bottom = height - 1;
  if (!horizontalOnly) {
    while (top < height && !rowHasContent(top)) top++;
    while (bottom > top && !rowHasContent(bottom)) bottom--;
  }

  const rect = {
    x: left / width,
    y: top / height,
    w: (right - left + 1) / width,
    h: (bottom - top + 1) / height,
  };
  if (rect.w < MIN_CONTENT || rect.h < MIN_CONTENT) return FULL_VIEW;
  // Drop margins too thin to matter, so a page isn't nudged by a pixel or two.
  const keep = (start: number, size: number) => {
    const end = 1 - start - size;
    const s = start < MIN_MARGIN ? 0 : start;
    const e = end < MIN_MARGIN ? 0 : end;
    return [s, 1 - s - e] as const;
  };
  const [x, w] = keep(rect.x, rect.w);
  const [y, h] = keep(rect.y, rect.h);
  return { x, y, w, h };
}

/** The left or right half of `view` (a split double page). */
export function halfOf(view: ViewRect, half: 'left' | 'right'): ViewRect {
  return { ...view, x: half === 'left' ? view.x : view.x + view.w / 2, w: view.w / 2 };
}

export const isFullView = (view: ViewRect) =>
  view.x === 0 && view.y === 0 && view.w === 1 && view.h === 1;

/** One snap position in the paged reader: the pages shown together, and for a split
 * double page which half of it. Page numbers are always the source's, so progress and
 * history never see the split. */
export type ReaderUnit = { pages: number[]; half?: 'left' | 'right'; rotate?: boolean };

/**
 * Groups pages into what the paged reader shows at once. In two-page mode "offset first
 * page" puts page 1 on its own so every later spread pairs the way the artist drew it, and
 * a page known to be a double spread already is never paired with another. In single-page
 * mode a double page can be split (`splitWide`, its halves in reading order: right half
 * first when reading right to left) or turned on its side (`rotateWide`); split wins.
 */
export function buildReaderUnits({
  totalPages,
  pagesPerView,
  offsetFirstPage,
  widePages,
  splitWide,
  rotateWide = false,
  rtl,
}: {
  totalPages: number;
  pagesPerView: 1 | 2;
  offsetFirstPage: boolean;
  widePages: ReadonlySet<number>;
  splitWide: boolean;
  rotateWide?: boolean;
  rtl: boolean;
}): ReaderUnit[] {
  const units: ReaderUnit[] = [];
  let p = 1;
  if (pagesPerView === 2 && offsetFirstPage && totalPages >= 1) {
    units.push({ pages: [1] });
    p = 2;
  }
  while (p <= totalPages) {
    const wide = widePages.has(p);
    if (pagesPerView === 1) {
      if (wide && splitWide) {
        const [first, second] = rtl ? (['right', 'left'] as const) : (['left', 'right'] as const);
        units.push({ pages: [p], half: first }, { pages: [p], half: second });
      } else if (wide && rotateWide) {
        units.push({ pages: [p], rotate: true });
      } else {
        units.push({ pages: [p] });
      }
      p += 1;
      continue;
    }
    // A spread on its own, and never a page paired with the spread after it.
    if (wide || p === totalPages || widePages.has(p + 1)) {
      units.push({ pages: [p] });
      p += 1;
    } else {
      units.push({ pages: [p, p + 1] });
      p += 2;
    }
  }
  return units;
}

/** The longest side the border scan samples at: plenty to find a margin, and cheap. */
const SCAN_SIZE = 240;
const boundsCache = new Map<string, ViewRect>();

/**
 * The content box of a loaded `<img>`, scanned on a small offscreen canvas and cached by
 * URL. Returns the full image when the pixels can't be read (a cross-origin image the
 * server didn't allow), so cropping only ever falls back to showing the whole page.
 */
export function measureContentBounds(img: HTMLImageElement, horizontalOnly: boolean): ViewRect {
  const key = `${horizontalOnly ? 'h' : 'a'}:${img.currentSrc || img.src}`;
  const cached = boundsCache.get(key);
  if (cached) return cached;
  let result = FULL_VIEW;
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
      result = findContentBounds(context.getImageData(0, 0, width, height).data, width, height, {
        horizontalOnly,
      });
    }
  } catch {
    // Tainted canvas: leave the page uncropped.
  }
  if (boundsCache.size > 500) boundsCache.clear();
  boundsCache.set(key, result);
  return result;
}

/** "Title - ch12 - p004" (no chapter part for a local comic), safe as a file name on every
 * desktop OS. */
export function pageImageFileName(
  title: string,
  chapter: number | undefined,
  page: number,
): string {
  const safe =
    title
      .split('')
      // Control characters and the ones Windows forbids in file names.
      .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? ' ' : char))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'page';
  const chapterPart = chapter === undefined ? '' : ` - ch${chapter}`;
  return `${safe}${chapterPart} - p${String(page).padStart(3, '0')}`;
}
