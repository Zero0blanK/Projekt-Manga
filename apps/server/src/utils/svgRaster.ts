/**
 * SVG images (some sources' icons) turned into PNG for the image proxy.
 *
 * The proxy never serves an SVG as-is: SVG can carry script, and the proxy answers from the
 * API's own origin. So an SVG icon used to fail outright. Drawn to a PNG here instead, it
 * shows like any other image, and nothing of the original document reaches the browser.
 *
 * `sharp` is optional (see thumbnailResize.ts); without it, the SVG is refused as before.
 */

/** Icons are tiny; anything bigger is not an icon. */
export const MAX_SVG_BYTES = 512 * 1024;
/** Plenty for an icon at any size it is shown, on any screen. */
const RASTER_WIDTH = 256;

/** Whether the first bytes look like an SVG document (possibly after an XML declaration). */
export function looksLikeSvg(head: Buffer): boolean {
  const text = head
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  // Step by step rather than one regex: a pattern with repeated comment groups backtracks
  // exponentially on input like `<!----><!---->…`, and this reads bytes from the internet.
  let rest = text;
  const skip = (open: string, close: string): boolean => {
    if (!rest.toLowerCase().startsWith(open)) return false;
    const end = rest.indexOf(close, open.length);
    if (end === -1) return false;
    rest = rest.slice(end + close.length).trimStart();
    return true;
  };
  skip('<?xml', '>');
  while (skip('<!--', '-->'));
  skip('<!doctype svg', '>');
  return /^<svg[\s>]/i.test(rest);
}

type Sharp = (input: Buffer, options?: { limitInputPixels?: number }) => import('sharp').Sharp;
let sharp: Promise<Sharp | null> | undefined;

/** The SVG as a PNG, or null when it can't be drawn (no sharp, or not a valid SVG). */
export async function rasterizeSvg(svg: Buffer): Promise<Buffer | null> {
  sharp ??= import('sharp').then(
    (module) => module.default as unknown as Sharp,
    () => null,
  );
  const library = await sharp;
  if (!library) return null;
  try {
    return await library(svg, { limitInputPixels: 4096 * 4096 })
      .resize({ width: RASTER_WIDTH, height: RASTER_WIDTH, fit: 'inside' })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}
