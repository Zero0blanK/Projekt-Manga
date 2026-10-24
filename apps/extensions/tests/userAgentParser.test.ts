import { describe, it, expect } from 'vitest';
import { parseUserAgentString } from '../utils/userAgentParser.js';

describe('parseUserAgentString', () => {
  it('parses Chrome on Windows', () => {
    const profile = parseUserAgentString(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    );
    expect(profile).toMatchObject({
      platform: 'Windows',
      browserType: 'Chrome',
      version: '130.0.0.0',
      mobile: false,
    });
    expect(profile?.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it('parses Edge as Edge, not Chrome, despite carrying a Chrome token', () => {
    const profile = parseUserAgentString(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    );
    expect(profile?.browserType).toBe('Edge');
  });

  it('parses Safari on MacOS', () => {
    const profile = parseUserAgentString(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    );
    expect(profile).toMatchObject({ platform: 'MacOS', browserType: 'Safari', mobile: false });
  });

  it('parses Firefox on Windows', () => {
    const profile = parseUserAgentString(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    );
    expect(profile).toMatchObject({ platform: 'Windows', browserType: 'Firefox' });
  });

  it('parses Android Chrome as mobile with a mobile hardware profile', () => {
    const profile = parseUserAgentString(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    );
    expect(profile).toMatchObject({ platform: 'Android', browserType: 'Chrome', mobile: true });
    expect(profile?.maxTouchPoints).toBeGreaterThan(0);
  });

  it('parses iOS Safari as mobile with the iOS hardware profile', () => {
    const profile = parseUserAgentString(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    );
    expect(profile).toMatchObject({ platform: 'iOS', browserType: 'Safari', mobile: true });
    expect(profile?.viewport).toEqual({ width: 390, height: 844 });
  });

  it('rejects strings with no recognizable browser signature', () => {
    expect(parseUserAgentString('not a real user agent')).toBeNull();
  });

  it('rejects known bot/crawler user agents', () => {
    expect(parseUserAgentString('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBeNull();
  });

  it('rejects empty or whitespace-only input', () => {
    expect(parseUserAgentString('')).toBeNull();
    expect(parseUserAgentString('   ')).toBeNull();
  });

  it('rejects absurdly long input', () => {
    const huge = 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36 ' + 'x'.repeat(1000);
    expect(parseUserAgentString(huge)).toBeNull();
  });
});
