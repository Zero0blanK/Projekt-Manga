/** The widths the server keeps library covers at (THUMBNAIL_WIDTHS in apps/server). */
export const COVER_WIDTHS = [200, 400, 800] as const;

/** A library cover's URL at `width`. Other covers (a source's, through the proxy) as given. */
export function coverAtWidth(src: string, width: number): string {
  if (!src.includes('/cache/thumbnail/')) return src;
  return `${src}${src.includes('?') ? '&' : '?'}w=${width}`;
}

/** The smallest stored width that is still sharp in a box `cssWidth` wide on this screen. */
export function coverWidthFor(cssWidth: number, pixelRatio: number): number {
  const needed = cssWidth * (pixelRatio || 1);
  return COVER_WIDTHS.find((candidate) => candidate >= needed) ?? 800;
}
