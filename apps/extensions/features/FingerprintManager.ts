/** Generates and manages randomized browser fingerprints. */

import {
  BrowserFingerprint,
  FingerprintConfig,
  UserAgentProfile,
  TIMEZONE_POOL,
  WEBGL_VENDORS,
  WEBGL_RENDERERS,
} from '../config/anon.config.js';
import { getUserAgentManager } from './UserAgentManager.js';

// Common desktop resolutions, for more realistic viewport randomization.
const COMMON_VIEWPORT_RESOLUTIONS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 2560, height: 1440 },
];

export class FingerprintManager {
  private config: FingerprintConfig;
  private currentFingerprint: BrowserFingerprint | null = null;

  constructor(config: FingerprintConfig) {
    this.config = config;
  }

  generateFingerprint(baseProfile?: UserAgentProfile): BrowserFingerprint {
    const uaManager = getUserAgentManager();
    const profile = baseProfile || uaManager.getCurrentProfile();

    const viewport = this.config.randomizeViewport ? this.randomizeViewport() : profile.viewport;

    const timezone = this.config.randomizeTimezone ? this.randomizeTimezone() : 'America/New_York';

    const language = this.config.randomizeLanguage ? this.randomizeLanguage() : 'en-US';

    const { vendor: webglVendor, renderer: webglRenderer } = this.config.randomizeWebGL
      ? this.randomizeWebGL(profile.platform)
      : { vendor: 'Google Inc.', renderer: 'ANGLE (Intel)' };

    let platform: string;
    switch (profile.platform) {
      case 'Windows':
        platform = 'Win32';
        break;
      case 'MacOS':
        platform = 'MacIntel';
        break;
      case 'Linux':
        platform = 'Linux x86_64';
        break;
      case 'Android':
        platform = 'Linux armv8l';
        break;
      case 'iOS':
        platform = 'iPhone';
        break;
      default:
        platform = 'Win32';
    }

    this.currentFingerprint = {
      userAgent: profile.userAgent,
      platform,
      viewport,
      deviceMemory: profile.deviceMemory,
      hardwareConcurrency: profile.hardwareConcurrency,
      maxTouchPoints: profile.maxTouchPoints,
      timezone,
      language,
      languages: [language, language.split('-')[0]!].filter(Boolean),
      colorDepth: 24,
      pixelRatio: profile.mobile ? 2 : 1,
      webglVendor,
      webglRenderer,
    };

    return this.currentFingerprint;
  }

  getCurrentFingerprint(): BrowserFingerprint {
    if (!this.currentFingerprint) {
      return this.generateFingerprint();
    }
    return this.currentFingerprint;
  }

  rotateFingerprint(): BrowserFingerprint {
    const uaManager = getUserAgentManager();
    const newProfile = uaManager.rotateProfile();
    return this.generateFingerprint(newProfile);
  }

  private randomizeViewport(): { width: number; height: number } {
    const { minWidth, maxWidth, minHeight, maxHeight } = this.config.viewportRange;

    // 70% of the time pick a common resolution that fits the range.
    if (Math.random() < 0.7) {
      const validResolutions = COMMON_VIEWPORT_RESOLUTIONS.filter(
        (r) =>
          r.width >= minWidth &&
          r.width <= maxWidth &&
          r.height >= minHeight &&
          r.height <= maxHeight,
      );
      if (validResolutions.length > 0) {
        return validResolutions[Math.floor(Math.random() * validResolutions.length)]!;
      }
    }

    // Otherwise a random size within range, in 10px steps.
    return {
      width: Math.floor((Math.random() * (maxWidth - minWidth + 1)) / 10) * 10 + minWidth,
      height: Math.floor((Math.random() * (maxHeight - minHeight + 1)) / 10) * 10 + minHeight,
    };
  }

  private randomizeTimezone(): string {
    const timezones = this.config.timezones.length > 0 ? this.config.timezones : TIMEZONE_POOL;
    return timezones[Math.floor(Math.random() * timezones.length)]!;
  }

  private randomizeLanguage(): string {
    const languages =
      this.config.languages.length > 0 ? this.config.languages : ['en-US', 'en-GB', 'en'];
    return languages[Math.floor(Math.random() * languages.length)]!;
  }

  private randomizeWebGL(platform: string): { vendor: string; renderer: string } {
    if (platform === 'MacOS') {
      return {
        vendor: 'Apple Inc.',
        renderer: Math.random() > 0.5 ? 'Apple M1 Pro' : 'Apple M2',
      };
    }

    const vendor = WEBGL_VENDORS[Math.floor(Math.random() * WEBGL_VENDORS.length)]!;

    let filteredRenderers = WEBGL_RENDERERS;
    if (vendor.includes('NVIDIA')) {
      filteredRenderers = WEBGL_RENDERERS.filter((r) => r.includes('NVIDIA'));
    } else if (vendor.includes('Intel')) {
      filteredRenderers = WEBGL_RENDERERS.filter((r) => r.includes('Intel'));
    } else if (vendor.includes('AMD')) {
      filteredRenderers = WEBGL_RENDERERS.filter((r) => r.includes('AMD') || r.includes('Radeon'));
    }

    if (filteredRenderers.length === 0) {
      filteredRenderers = WEBGL_RENDERERS;
    }

    return {
      vendor,
      renderer: filteredRenderers[Math.floor(Math.random() * filteredRenderers.length)]!,
    };
  }

  updateConfig(config: Partial<FingerprintConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      viewportRange: {
        ...this.config.viewportRange,
        ...config.viewportRange,
      },
    };
  }
}

/**
 * Builds the browser-context fingerprint-override script as a plain string so Puppeteer
 * (evaluateOnNewDocument) and Playwright (addInitScript) inject identical patching logic.
 */
export function buildFingerprintInjectionScript(fp: BrowserFingerprint): string {
  return `(() => {
  const fp = ${JSON.stringify(fp)};
  const nav = navigator;
  const scr = screen;
  const win = window;

  Object.defineProperty(nav, 'platform', { get: () => fp.platform });
  Object.defineProperty(nav, 'deviceMemory', { get: () => fp.deviceMemory });
  Object.defineProperty(nav, 'hardwareConcurrency', { get: () => fp.hardwareConcurrency });
  Object.defineProperty(nav, 'maxTouchPoints', { get: () => fp.maxTouchPoints });
  Object.defineProperty(nav, 'webdriver', { get: () => false });
  Object.defineProperty(nav, 'language', { get: () => fp.language });
  Object.defineProperty(nav, 'languages', { get: () => fp.languages });

  Object.defineProperty(scr, 'colorDepth', { get: () => fp.colorDepth });
  Object.defineProperty(win, 'devicePixelRatio', { get: () => fp.pixelRatio });

  const origDTF = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (locales, options) {
    return new origDTF(locales, Object.assign({}, options, { timeZone: (options && options.timeZone) || fp.timezone }));
  };
  Intl.DateTimeFormat.prototype = origDTF.prototype;

  const WebGLRC = win.WebGLRenderingContext;
  if (WebGLRC) {
    const getParam = WebGLRC.prototype.getParameter;
    WebGLRC.prototype.getParameter = function (p) {
      if (p === 37445) return fp.webglVendor;
      if (p === 37446) return fp.webglRenderer;
      return getParam.call(this, p);
    };
  }

  const WebGL2RC = win.WebGL2RenderingContext;
  if (WebGL2RC) {
    const getParam2 = WebGL2RC.prototype.getParameter;
    WebGL2RC.prototype.getParameter = function (p) {
      if (p === 37445) return fp.webglVendor;
      if (p === 37446) return fp.webglRenderer;
      return getParam2.call(this, p);
    };
  }

  const HTMLCanvas = win.HTMLCanvasElement;
  if (HTMLCanvas) {
    const origToDataURL = HTMLCanvas.prototype.toDataURL;
    HTMLCanvas.prototype.toDataURL = function (type, quality) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imgData = ctx.getImageData(0, 0, this.width, this.height);
        const data = imgData.data;
        const seed = fp.webglRenderer.length;
        // Perturbs 1% of pixels by +/-1 on the red channel: visually identical, but it
        // changes the exact bytes so canvas-fingerprint hashes differ from other renders.
        for (let i = 0; i < data.length; i += 4) {
          if (Math.random() < 0.01) data[i] += (seed % 3) - 1;
        }
        ctx.putImageData(imgData, 0, 0);
      }
      return origToDataURL.call(this, type, quality);
    };
  }
})();`;
}

let fingerprintManagerInstance: FingerprintManager | null = null;

export function getFingerprintManager(config?: FingerprintConfig): FingerprintManager {
  if (!fingerprintManagerInstance && config) {
    fingerprintManagerInstance = new FingerprintManager(config);
  }
  if (!fingerprintManagerInstance) {
    fingerprintManagerInstance = new FingerprintManager({
      randomizeViewport: true,
      viewportRange: {
        minWidth: 1280,
        maxWidth: 1920,
        minHeight: 720,
        maxHeight: 1080,
      },
      randomizeTimezone: true,
      timezones: TIMEZONE_POOL,
      randomizeLanguage: false,
      languages: ['en-US', 'en-GB', 'en'],
      randomizeWebGL: true,
      randomizeCanvas: true,
      rotateOnFailure: true,
    });
  }
  return fingerprintManagerInstance;
}

export function resetFingerprintManager(): void {
  fingerprintManagerInstance = null;
}
