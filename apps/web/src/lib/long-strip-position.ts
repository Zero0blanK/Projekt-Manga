/** Where on screen the "current" page is read from, as a fraction of the viewport height. */
export const READING_LINE = 1 / 3;

/**
 * The page under the reading line: the one whose box spans `lineY`, or failing that (a gap
 * between pages, or the line past the last one) the last page that starts above it.
 *
 * Measured by position rather than by how much of each page is visible: webtoon pages are
 * often several screens tall, so a visibility ratio like "half the page on screen" is never
 * reached and the counter would skip them or stick.
 */
export function pageAtLine(
  pages: Iterable<[string, Pick<HTMLElement, 'getBoundingClientRect'>]>,
  lineY: number,
): string | null {
  let above: { key: string; top: number } | null = null;
  for (const [key, el] of pages) {
    const { top, bottom } = el.getBoundingClientRect();
    if (top <= lineY && bottom > lineY) return key;
    if (top <= lineY && (!above || top > above.top)) above = { key, top };
  }
  return above?.key ?? null;
}
