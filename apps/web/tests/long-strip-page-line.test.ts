import { describe, expect, it } from 'vitest';
import { pageAtLine } from '@/lib/long-strip-position';

/** A page laid out from `top` to `bottom` in viewport coordinates. */
const page = (key: string, top: number, bottom: number) =>
  [key, { getBoundingClientRect: () => ({ top, bottom }) as DOMRect }] as const;

describe('long-strip current page', () => {
  it('counts a page taller than the screen while it covers the reading line', () => {
    // A webtoon page several screens tall: never half visible, still the page being read.
    const pages = [page('1:1', -3000, 2400), page('1:2', 2400, 6000)];
    expect(pageAtLine(pages, 300)).toBe('1:1');
  });

  it('moves to the next page once it reaches the reading line, not when half of it shows', () => {
    const pages = [page('1:1', -2000, 250), page('1:2', 250, 4000)];
    expect(pageAtLine(pages, 300)).toBe('1:2');
  });

  it('keeps the page above when the line falls in the gap between pages', () => {
    const pages = [page('1:3', -500, 280), page('1:4', 320, 900)];
    expect(pageAtLine(pages, 300)).toBe('1:3');
  });

  it('follows the strip across a chapter boundary in either direction', () => {
    const pages = [page('1:20', -900, 100), page('2:1', 100, 1100)];
    expect(pageAtLine(pages, 300)).toBe('2:1');
    expect(pageAtLine(pages, 50)).toBe('1:20');
  });

  it('reports nothing before any page reaches the line', () => {
    expect(pageAtLine([page('1:1', 400, 900)], 300)).toBeNull();
  });
});
