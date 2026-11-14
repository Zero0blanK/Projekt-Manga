import { afterEach, describe, expect, it, vi } from 'vitest';

const readPageText = vi.fn();
const readPageTextWith = vi.fn();
// The whole-page path hands the page to the server; the server is faked below.
const readPageTextOnServer = vi.fn(
  async (_url: string, read: (image: string) => Promise<unknown>) => read('page-base64'),
);
const translateTexts = vi.fn();
const api = vi.hoisted(() => ({
  localStatus: vi.fn(async (): Promise<unknown> => ({ enabled: false })),
  download: vi.fn(async () => ({})),
  readBubbles: vi.fn(),
  readPage: vi.fn(),
}));
vi.mock('@/lib/page-ocr', async (original) => ({
  ...(await original<typeof import('@/lib/page-ocr')>()),
  readPageText: (url: string) => readPageText(url),
  readPageTextWith: (url: string, read: (images: string[]) => Promise<string[]>) =>
    readPageTextWith(url, read),
  readPageTextOnServer: (url: string, read: (image: string) => Promise<unknown>) =>
    readPageTextOnServer(url, read),
}));
vi.mock('@projekt-manga/api-client', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    getTranslateStatus: vi.fn(async () => ({ enabled: true, provider: 'libretranslate' })),
    translateTexts: (body: unknown) => translateTexts(body),
    getLocalTranslationStatus: () => api.localStatus(),
    downloadLocalTranslation: () => api.download(),
    readBubbleTexts: (body: unknown) => api.readBubbles(body),
    readPageRegions: (body: unknown) => api.readPage(body),
  };
});

import { cleanText, findTextAreas, inReadingOrder } from '@/lib/page-ocr';
import {
  fitFontSize,
  pageTranslation,
  resetPageTranslations,
  showOriginal,
  translatePage,
  translateTargetFor,
} from '@/lib/page-translation';

afterEach(() => {
  resetPageTranslations();
  readPageText.mockReset();
  readPageTextWith.mockReset();
  translateTexts.mockReset();
  api.localStatus.mockReset().mockResolvedValue({ enabled: false });
  api.download.mockClear();
  api.readBubbles.mockReset();
  // A server from before it could find the text itself, unless a test says otherwise.
  api.readPage.mockReset().mockImplementation(async () => {
    const { ApiError } = await import('@projekt-manga/api-client');
    throw new (ApiError as unknown as new (message: string, status: number) => Error)(
      'Not found',
      404,
    );
  });
});

/** A synthetic scan: paper, with hatching, ellipses and glyph-like marks painted on. */
function scan(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const set = (x: number, y: number, value: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = value;
  };
  return {
    data,
    width,
    height,
    hatch(x0: number, y0: number, x1: number, y1: number) {
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) if ((x + y) % 6 === 0) set(x, y, 0);
    },
    /** A white ellipse with a black outline. */
    bubble(cx: number, cy: number, rx: number, ry: number) {
      for (let y = cy - ry - 2; y <= cy + ry + 2; y++)
        for (let x = cx - rx - 2; x <= cx + rx + 2; x++) {
          const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          if (d <= 1) set(x, y, 255);
          else if (d <= 1.08) set(x, y, 0);
        }
    },
    /** A column of glyph-sized marks: a vertical line of text. */
    column(x: number, y0: number, count: number, glyph = 8) {
      for (let n = 0; n < count; n++)
        for (let y = 0; y < glyph; y++)
          for (let dx = 0; dx < glyph; dx++)
            if (dx === 0 || y === 0 || dx === glyph - 1 || y === glyph - 1)
              set(x + dx, y0 + n * (glyph + 3) + y, 0);
    },
  };
}

describe('finding text on a page', () => {
  it('finds a bubble over hatching, and keeps the art outside it out of the reading', () => {
    const page = scan(300, 450);
    page.hatch(0, 0, 300, 450);
    page.bubble(150, 150, 60, 90);
    page.column(160, 90, 9);
    page.column(140, 90, 6);
    const areas = findTextAreas(page.data, page.width, page.height);
    expect(areas).toHaveLength(1);
    const [bubble] = areas;
    expect(bubble.kind).toBe('bubble');
    expect(bubble.box.x0).toBeGreaterThanOrEqual(88);
    expect(bubble.box.x1).toBeLessThanOrEqual(212);
    expect(bubble.keep(150, 150)).toBe(true);
    // A corner of the bounding box is hatching outside the ellipse.
    expect(bubble.keep(bubble.box.x0 + 1, bubble.box.y0 + 1)).toBe(false);
  });

  it('finds text running into the margin, by its glyphs in solid paper', () => {
    const page = scan(300, 450);
    page.hatch(20, 120, 280, 430);
    // Paper reaching the page's edge (a bubble cut off by it), so no closed bubble.
    page.column(240, 10, 8);
    page.column(225, 10, 5);
    const areas = findTextAreas(page.data, page.width, page.height);
    expect(areas.map((area) => area.kind)).toEqual(['loose']);
    expect(areas[0].box.x0).toBeLessThanOrEqual(225);
    expect(areas[0].box.y1).toBeLessThanOrEqual(120);
  });

  it('ignores an empty bubble, white art and hatching', () => {
    const page = scan(300, 450);
    page.hatch(0, 0, 300, 450);
    page.bubble(150, 220, 60, 60); // no text in it
    expect(findTextAreas(page.data, page.width, page.height)).toEqual([]);
  });
});

describe('cleaning up and laying out what OCR read', () => {
  it('drops spaces and stray Latin, and puts vertical punctuation right', () => {
    expect(cleanText('こ ん に ち は')).toBe('こんにちは');
    expect(cleanText('俺はまだ負けてないkklb')).toBe('俺はまだ負けてない');
    expect(cleanText('ありがとう本当に)助かった')).toBe('ありがとう本当に助かった');
    expect(cleanText('もう遅いよ:::ずっと')).toBe('もう遅いよ…ずっと');
    expect(cleanText('どうしてここにいるの7')).toBe('どうしてここにいるの？');
    // A digit that is part of the text stays.
    expect(cleanText('第2話')).toBe('第2話');
  });

  it('orders bubbles right to left within a row, rows top to bottom', () => {
    const at = (x: number, y: number) => ({ x, y, w: 0.1, h: 0.1 });
    expect(inReadingOrder([at(0.2, 0.03), at(0.6, 0.06), at(0.5, 0.5)])).toEqual([
      at(0.6, 0.06),
      at(0.2, 0.03),
      at(0.5, 0.5),
    ]);
  });

  it('sizes text to its box', () => {
    const short = fitFontSize('Hi', 0.2, 0.1, 1.5);
    const long = fitFontSize('A much longer line of dialogue here', 0.2, 0.1, 1.5);
    expect(short).toBeGreaterThan(long);
    expect(short).toBeLessThanOrEqual(0.1);
    expect(fitFontSize('x'.repeat(5000), 0.01, 0.01, 1)).toBe(0.008);
  });
});

describe('translating a page', () => {
  it('translates the regions, then switches between original and translation', async () => {
    readPageText.mockResolvedValue([
      { text: 'こんにちは', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { text: 'ありがとう', x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    ]);
    translateTexts.mockResolvedValue({ translations: ['Hello', 'Thanks'] });
    await translatePage('page-1.png', translateTargetFor('French'));
    expect(translateTexts).toHaveBeenCalledWith({
      texts: ['こんにちは', 'ありがとう'],
      target: 'fr',
    });
    expect(pageTranslation('page-1.png')).toMatchObject({
      status: 'done',
      shown: true,
      regions: [{ text: 'Hello' }, { text: 'Thanks' }],
    });

    showOriginal('page-1.png');
    expect(pageTranslation('page-1.png')).toMatchObject({ status: 'done', shown: false });
    // Showing it again reuses the translation.
    await translatePage('page-1.png', 'fr');
    expect(translateTexts).toHaveBeenCalledTimes(1);
    expect(pageTranslation('page-1.png')).toMatchObject({ shown: true });
  });

  it('says so when there is nothing to translate or the server fails', async () => {
    readPageText.mockResolvedValue([]);
    await translatePage('blank.png', 'en');
    expect(pageTranslation('blank.png')).toEqual({
      status: 'error',
      message: 'No Japanese text was found on this page',
    });
    expect(translateTexts).not.toHaveBeenCalled();

    readPageText.mockResolvedValue([{ text: '猫です', x: 0, y: 0, w: 0.1, h: 0.1 }]);
    translateTexts.mockRejectedValue(new Error('Translation is not set up on this server'));
    await translatePage('cat.png', 'en');
    expect(pageTranslation('cat.png')).toEqual({
      status: 'error',
      message: 'Translation is not set up on this server',
    });
    expect(translateTargetFor('Klingon')).toBe('en');
  });

  it('reads the bubbles on the server once its models are in, else here while they download', async () => {
    api.localStatus.mockResolvedValue({
      enabled: true,
      state: 'missing',
      size: 1,
      targets: ['en'],
    });
    readPageText.mockResolvedValue([{ text: '猫です', x: 0, y: 0, w: 0.1, h: 0.1 }]);
    translateTexts.mockResolvedValue({ translations: ['A cat'] });
    await translatePage('first.png', 'en');
    expect(readPageText).toHaveBeenCalledWith('first.png');
    expect(api.download).toHaveBeenCalledTimes(1);

    api.localStatus.mockResolvedValue({ enabled: true, state: 'ready', size: 1, targets: ['en'] });
    api.readBubbles.mockResolvedValue({ texts: ['犬です'] });
    readPageTextWith.mockImplementation(async (_url, read) => {
      const [text] = await read(['png-base64']);
      return [{ text, x: 0, y: 0, w: 0.1, h: 0.1 }];
    });
    translateTexts.mockResolvedValue({ translations: ['A dog'] });
    await translatePage('second.png', 'en');
    expect(api.readBubbles).toHaveBeenCalledWith({ images: ['png-base64'] });
    expect(readPageText).toHaveBeenCalledTimes(1);
    expect(pageTranslation('second.png')).toMatchObject({ regions: [{ text: 'A dog' }] });
  });

  it('reads here again on a server from before local translation', async () => {
    const { ApiError } = await import('@projekt-manga/api-client');
    api.localStatus.mockResolvedValue({ enabled: true, state: 'ready', size: 1, targets: ['en'] });
    readPageTextWith.mockRejectedValue(new ApiError('Not found', 404));
    readPageText.mockResolvedValue([{ text: '猫です', x: 0, y: 0, w: 0.1, h: 0.1 }]);
    translateTexts.mockResolvedValue({ translations: ['A cat'] });
    await translatePage('old-server.png', 'en');
    expect(readPageText).toHaveBeenCalledWith('old-server.png');
    expect(pageTranslation('old-server.png')).toMatchObject({ status: 'done' });
  });
});

describe('translating every page', () => {
  it('translates each page in turn and says how it went', async () => {
    readPageText.mockImplementation(async (url: string) =>
      url === 'blank.png' ? [] : [{ text: '猫です', x: 0, y: 0, w: 0.1, h: 0.1 }],
    );
    translateTexts.mockResolvedValue({ translations: ['A cat'] });
    const { translateAll } = await import('@/lib/page-translation');
    await translateAll(['one.png', 'blank.png', 'three.png'], 'en');
    expect(
      ['one.png', 'blank.png', 'three.png'].map((url) => pageTranslation(url)?.status),
    ).toEqual(['done', 'error', 'done']);
  });

  it('stops after the page in hand', async () => {
    const { translateAll, stopTranslateAll } = await import('@/lib/page-translation');
    readPageText.mockImplementation(async () => {
      stopTranslateAll();
      return [{ text: '猫です', x: 0, y: 0, w: 0.1, h: 0.1 }];
    });
    translateTexts.mockResolvedValue({ translations: ['A cat'] });
    await translateAll(['first.png', 'second.png'], 'en');
    expect(pageTranslation('first.png')?.status).toBe('done');
    expect(pageTranslation('second.png')).toBeNull();
  });
});

describe('one reading per bubble', () => {
  it('drops a region found again inside a larger one', async () => {
    const { withoutOverlaps } = await import('@/lib/page-ocr');
    const bubble = { text: 'a', x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    const inside = { text: 'b', x: 0.15, y: 0.15, w: 0.1, h: 0.1 };
    const elsewhere = { text: 'c', x: 0.6, y: 0.6, w: 0.2, h: 0.2 };
    expect(
      withoutOverlaps([inside, bubble, elsewhere])
        .map((r) => r.text)
        .sort(),
    ).toEqual(['a', 'c']);
  });
});

describe('finding the text on the server', () => {
  it("uses the server's text detector when it has one", async () => {
    api.localStatus.mockResolvedValue({ enabled: true, state: 'ready', size: 1, targets: ['en'] });
    api.readPage.mockReset().mockResolvedValue({
      regions: [{ text: '犬です', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }],
    });
    translateTexts.mockResolvedValue({ translations: ['A dog'] });
    await translatePage('detected.png', 'en');
    expect(api.readPage).toHaveBeenCalledWith({ image: 'page-base64' });
    expect(readPageTextWith).not.toHaveBeenCalled();
    expect(readPageText).not.toHaveBeenCalled();
    expect(pageTranslation('detected.png')).toMatchObject({ regions: [{ text: 'A dog' }] });
  });
});
