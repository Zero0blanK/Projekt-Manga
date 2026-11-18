import { describe, expect, it } from 'vitest';
import { looksLikeSvg, rasterizeSvg } from '../src/utils/svgRaster.js';

const icon = Buffer.from(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#e11"/></svg>',
);

describe('SVG icons through the image proxy', () => {
  it('recognises an SVG, with or without an XML declaration or comment', () => {
    expect(looksLikeSvg(icon)).toBe(true);
    expect(looksLikeSvg(Buffer.from('<svg viewBox="0 0 1 1"></svg>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('<!-- logo --><svg></svg>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('<html><body><svg></svg></body></html>'))).toBe(false);
    expect(looksLikeSvg(Buffer.from('not an image'))).toBe(false);
  });

  it('draws it to a PNG, so the SVG itself is never served', async () => {
    const png = await rasterizeSvg(icon);
    expect(png?.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png?.includes(Buffer.from('<svg'))).toBe(false);
  });

  it('refuses something that only claims to be one', async () => {
    expect(await rasterizeSvg(Buffer.from('<svg><unclosed'))).toBeNull();
  });
});
