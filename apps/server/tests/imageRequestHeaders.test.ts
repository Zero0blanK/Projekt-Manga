import { describe, expect, it } from 'vitest';
import { APP_USER_AGENT, createImageRequestHeaders } from '../src/utils/userAgent.js';

describe('image request headers', () => {
  it("identifies the app to MangaDex's image hosts instead of posing as a browser", () => {
    for (const url of [
      'https://uploads.mangadex.org/covers/abc/def.jpg.256.jpg',
      'https://cmdxd98sb0x3yprd.mangadex.network/data/hash/page.png',
    ]) {
      const headers = createImageRequestHeaders('mangadex', {}, url);
      expect(headers['User-Agent']).toBe(APP_USER_AGENT);
      expect(headers.Referer).toBe('https://mangadex.org/');
    }
  });

  it('keeps the browser User-Agent for every other host', () => {
    const headers = createImageRequestHeaders(undefined, {}, 'https://notmangadex.org/a.jpg');
    expect(headers['User-Agent']).not.toBe(APP_USER_AGENT);
    expect(headers['User-Agent']).toMatch(/^Mozilla\//);
  });

  it('lets a User-Agent saved with a pasted session win', () => {
    const headers = createImageRequestHeaders(
      'mangadex',
      { 'User-Agent': 'Mozilla/5.0 saved-session' },
      'https://uploads.mangadex.org/covers/a.jpg',
    );
    expect(headers['User-Agent']).toBe('Mozilla/5.0 saved-session');
  });
});
