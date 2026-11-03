import { describe, it, expect } from 'vitest';
import {
  alignFingerprintWithBrowser,
  buildFingerprintInjectionScript,
  buildUserAgentMetadata,
  createFallbackFingerprint,
} from '../features/FingerprintManager.js';
import type { BrowserFingerprint } from '../config/anon.config.js';

const baseFingerprint: BrowserFingerprint = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  platform: 'Win32',
  viewport: { width: 1920, height: 1080 },
  deviceMemory: 8,
  hardwareConcurrency: 8,
  maxTouchPoints: 0,
  timezone: 'America/New_York',
  language: 'en-US',
  languages: ['en-US', 'en'],
  colorDepth: 24,
  pixelRatio: 1,
  webglVendor: 'Google Inc. (Intel)',
  webglRenderer: 'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
};

describe('alignFingerprintWithBrowser', () => {
  it('replaces a Firefox UA with the actual Chromium version', () => {
    const aligned = alignFingerprintWithBrowser(
      {
        ...baseFingerprint,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
      },
      'Chrome/141.0.7390.54',
    );

    expect(aligned.userAgent).toContain('Chrome/141.0.0.0');
    expect(aligned.userAgent).not.toContain('Firefox');
    expect(aligned.platform).toBe('Win32');
  });

  it('converts an iOS Safari profile into a mobile Chromium identity', () => {
    const aligned = alignFingerprintWithBrowser(
      {
        ...baseFingerprint,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
      },
      '141.0.7390.54',
    );

    expect(aligned.userAgent).toContain('Chrome/141.0.0.0 Mobile');
    expect(aligned.platform).toBe('Linux armv8l');
    expect(aligned.maxTouchPoints).toBeGreaterThanOrEqual(5);
    expect(aligned.pixelRatio).toBe(2);
    expect(aligned.webglRenderer).toContain('Adreno');
  });

  it('keeps the platform identity without rewriting WebGL when it already matches', () => {
    const aligned = alignFingerprintWithBrowser(
      {
        ...baseFingerprint,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        platform: 'MacIntel',
      },
      'Chrome/141.0.7390.54',
    );

    expect(aligned.userAgent).toContain('Macintosh');
    expect(aligned.userAgent).toContain('Chrome/141.0.0.0');
    expect(aligned.platform).toBe('MacIntel');
    expect(aligned.webglRenderer).toBe(baseFingerprint.webglRenderer);
  });

  it('preserves Edge branding when the source UA was Edge', () => {
    const aligned = alignFingerprintWithBrowser(
      {
        ...baseFingerprint,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
      },
      'Chrome/141.0.7390.54',
    );

    expect(aligned.userAgent).toContain('Edg/141.0.0.0');
  });

  it('aligns the fallback fingerprint to a usable Chromium UA', () => {
    const aligned = alignFingerprintWithBrowser(createFallbackFingerprint(), '141.0.7390.54');

    expect(aligned.userAgent).toContain('Chrome/141.0.0.0');
    expect(aligned.platform).toBe('Win32');
    expect(aligned.maxTouchPoints).toBe(0);
  });
});

describe('buildUserAgentMetadata', () => {
  it('matches the aligned user agent, platform, and full version', () => {
    const aligned = alignFingerprintWithBrowser(baseFingerprint, '141.0.7390.54');
    const metadata = buildUserAgentMetadata(aligned);

    expect(metadata.platform).toBe('Windows');
    expect(metadata.mobile).toBe(false);
    expect(metadata.architecture).toBe('x86');
    expect(metadata.brands).toContainEqual({ brand: 'Google Chrome', version: '141' });
    expect(metadata.brands).toContainEqual({ brand: 'Chromium', version: '141' });
    expect(metadata.fullVersionList[0]).toEqual({
      brand: 'Chromium',
      version: '141.0.7390.54',
    });
  });

  it('reports Android hints for a mobile Chromium identity', () => {
    const aligned = alignFingerprintWithBrowser(
      { ...baseFingerprint, platform: 'Linux armv8l', maxTouchPoints: 5 },
      '141.0.7390.54',
    );
    const metadata = buildUserAgentMetadata(aligned);

    expect(metadata.platform).toBe('Android');
    expect(metadata.mobile).toBe(true);
    expect(metadata.architecture).toBe('arm');
    expect(metadata.model).toBe('Pixel 8');
    expect(metadata.formFactors).toEqual(['Mobile']);
  });

  it('advertises Edge brands when the aligned UA keeps Edge', () => {
    const aligned = alignFingerprintWithBrowser(
      {
        ...baseFingerprint,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
      },
      '141.0.7390.54',
    );
    const metadata = buildUserAgentMetadata(aligned);

    expect(metadata.brands).toContainEqual({ brand: 'Microsoft Edge', version: '141' });
  });
});

describe('stealth injection script hardening', () => {
  it('covers client hints, Chrome globals, plugins, and deterministic canvas noise', () => {
    const script = buildFingerprintInjectionScript(baseFingerprint);

    expect(script).toContain('userAgentData');
    expect(script).toContain('getHighEntropyValues');
    expect(script).toContain('win.chrome');
    expect(script).toContain("Object.defineProperty(nav, 'plugins'");
    expect(script).toContain("Object.defineProperty(scr, 'width'");
    expect(script).not.toContain('Math.random');
  });
});
