import { describe, it, expect } from 'vitest';
import { buildFingerprintInjectionScript } from '../features/FingerprintManager.js';
import type { BrowserFingerprint } from '../config/anon.config.js';

const sampleFingerprint: BrowserFingerprint = {
  userAgent: 'Mozilla/5.0 Test',
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
  webglVendor: 'Intel Inc.',
  webglRenderer: 'ANGLE (Intel(R) UHD Graphics 630)',
};

/**
 * The injected script only runs inside a real page, so outside a live browser the only
 * things worth pinning are that it is syntactically valid and that it references the
 * fingerprint values it is meant to spoof.
 */
describe('buildFingerprintInjectionScript', () => {
  it('produces syntactically valid JavaScript', () => {
    const script = buildFingerprintInjectionScript(sampleFingerprint);
    expect(() => new Function(script)).not.toThrow();
  });

  it('embeds the fingerprint values as a literal, not a reference', () => {
    const script = buildFingerprintInjectionScript(sampleFingerprint);
    expect(script).toContain(JSON.stringify(sampleFingerprint));
  });

  it('patches navigator, screen, WebGL, WebGL2, canvas, and Intl.DateTimeFormat', () => {
    const script = buildFingerprintInjectionScript(sampleFingerprint);
    expect(script).toContain("Object.defineProperty(nav, 'platform'");
    expect(script).toContain("Object.defineProperty(nav, 'webdriver', { get: () => false }");
    expect(script).toContain("Object.defineProperty(scr, 'colorDepth'");
    expect(script).toContain('WebGLRenderingContext');
    expect(script).toContain('WebGL2RenderingContext');
    expect(script).toContain('HTMLCanvasElement');
    expect(script).toContain('Intl.DateTimeFormat');
  });

  it('runs cleanly in a DOM-less context (defineProperty targets exist as plain objects)', () => {
    // Not a browser, so this can't assert the spoofed values took effect — it only
    // proves the script doesn't throw when navigator/screen/window are plain stand-ins,
    // which is what evaluateOnNewDocument/addInitScript actually run against.
    const script = buildFingerprintInjectionScript(sampleFingerprint);
    const fn = new Function(
      'navigator',
      'screen',
      'window',
      'Intl',
      `${script}\nreturn { platform: navigator.platform, webdriver: navigator.webdriver };`,
    );
    const fakeIntl = { DateTimeFormat: Intl.DateTimeFormat };
    const result = fn({}, {}, { WebGLRenderingContext: undefined }, fakeIntl);
    expect(result.platform).toBe('Win32');
    expect(result.webdriver).toBe(false);
  });
});
