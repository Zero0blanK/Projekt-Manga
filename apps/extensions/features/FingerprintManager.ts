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

export interface BrowserUserAgentMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  formFactors: string[];
}

interface ChromiumTarget {
  os: 'windows' | 'mac' | 'linux' | 'android';
  platform: string;
  chromePlatform: string;
  mobile: boolean;
}

function resolveChromiumTarget(fingerprint: BrowserFingerprint): ChromiumTarget {
  switch (fingerprint.platform) {
    case 'MacIntel':
      return { os: 'mac', platform: 'MacIntel', chromePlatform: 'macOS', mobile: false };
    case 'Linux x86_64':
      return { os: 'linux', platform: 'Linux x86_64', chromePlatform: 'Linux', mobile: false };
    case 'Linux armv8l':
    case 'iPhone':
      return { os: 'android', platform: 'Linux armv8l', chromePlatform: 'Android', mobile: true };
    default:
      return { os: 'windows', platform: 'Win32', chromePlatform: 'Windows', mobile: false };
  }
}

function isEdgeUserAgent(userAgent: string): boolean {
  return /\bEdg[A-Za-z]*\//.test(userAgent);
}

function chromiumUserAgent(os: ChromiumTarget['os'], major: string, edge: boolean): string {
  const suffix = edge ? ` Edg/${major}.0.0.0` : '';
  switch (os) {
    case 'mac':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${suffix}`;
    case 'linux':
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${suffix}`;
    case 'android':
      return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
    default:
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${suffix}`;
  }
}

function parseBrowserVersion(input: string): { major: string; fullVersion: string } {
  const match =
    /(?:HeadlessChrome|Chrome|Chromium|Edg|EdgA|EdgiOS)\/(\d+(?:\.\d+){0,3})/.exec(input) ??
    /(\d+(?:\.\d+){0,3})/.exec(input);
  const raw = match?.[1] ?? '124.0.0.0';
  const [major = '124', minor = '0', build = '0', patch = '0'] = raw.split('.');
  return {
    major,
    fullVersion: `${major}.${minor}.${build}.${patch}`,
  };
}

function webglForTarget(target: ChromiumTarget): { vendor: string; renderer: string } {
  switch (target.platform) {
    case 'MacIntel':
      return { vendor: 'Apple Inc.', renderer: 'Apple M2' };
    case 'Linux x86_64':
      return {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
      };
    case 'Linux armv8l':
      return {
        vendor: 'Google Inc. (Qualcomm)',
        renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',
      };
    default:
      return {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
      };
  }
}

/**
 * Rewrites a generated fingerprint so its user agent, platform, touch support, device
 * pixel ratio, and WebGL identity all describe the actual Chromium build. The UA pools
 * include Firefox/Safari/mobile profiles whose client hints CDP cannot fake in a
 * Chromium binary; keeping them produces the exact inconsistencies challenge scripts use
 * to reject a headless session.
 */
export function alignFingerprintWithBrowser(
  fingerprint: BrowserFingerprint,
  browserVersion: string,
): BrowserFingerprint {
  const { major, fullVersion } = parseBrowserVersion(browserVersion);
  const target = resolveChromiumTarget(fingerprint);
  const edge = !target.mobile && isEdgeUserAgent(fingerprint.userAgent);
  const platformChanged = fingerprint.platform !== target.platform;

  const aligned: BrowserFingerprint = {
    ...fingerprint,
    userAgent: chromiumUserAgent(target.os, major, edge),
    browserVersion: fullVersion,
    platform: target.platform,
    maxTouchPoints: target.mobile ? Math.max(fingerprint.maxTouchPoints, 5) : 0,
    pixelRatio: target.mobile ? 2 : 1,
  };

  if (platformChanged) {
    const webgl = webglForTarget(target);
    aligned.webglVendor = webgl.vendor;
    aligned.webglRenderer = webgl.renderer;
  }

  return aligned;
}

/** Mirrors the q-values Chromium sends so the header and navigator.languages agree. */
export function buildAcceptLanguage(languages: string[]): string {
  return languages
    .map((language, index) =>
      index === 0 ? language : `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`,
    )
    .join(',');
}

/** Client hints must agree with the user agent string and with navigator.userAgentData. */
export function buildUserAgentMetadata(fp: BrowserFingerprint): BrowserUserAgentMetadata {
  const { major, fullVersion } = parseBrowserVersion(fp.browserVersion ?? fp.userAgent);
  const target = resolveChromiumTarget(fp);
  const edge = !target.mobile && isEdgeUserAgent(fp.userAgent);
  const brand = edge ? 'Microsoft Edge' : 'Google Chrome';

  return {
    brands: [
      { brand: 'Chromium', version: major },
      { brand, version: major },
      { brand: 'Not A(Brand', version: '99' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: fullVersion },
      { brand, version: fullVersion },
      { brand: 'Not A(Brand', version: '99.0.0.0' },
    ],
    platform: target.chromePlatform,
    platformVersion:
      target.chromePlatform === 'Windows'
        ? '10.0.0'
        : target.chromePlatform === 'macOS' || target.chromePlatform === 'Android'
          ? '14.0.0'
          : '6.5.0',
    architecture: target.mobile ? 'arm' : 'x86',
    model: target.mobile ? 'Pixel 8' : '',
    mobile: target.mobile,
    bitness: '64',
    wow64: false,
    formFactors: [target.mobile ? 'Mobile' : 'Desktop'],
  };
}

/** A conservative desktop fingerprint used when anti-detection did not supply one. */
export function createFallbackFingerprint(): BrowserFingerprint {
  return {
    userAgent: '',
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
}

/**
 * Builds the browser-context fingerprint-override script as a plain string so Puppeteer
 * (evaluateOnNewDocument) and Playwright (addInitScript) inject identical patching logic.
 */
export function buildFingerprintInjectionScript(fp: BrowserFingerprint): string {
  const metadata = buildUserAgentMetadata(fp);

  return `(() => {
  const fp = ${JSON.stringify(fp)};
  const meta = ${JSON.stringify(metadata)};
  const nav = navigator;
  const scr = screen;
  const win = window;
  const mobile = meta.mobile;
  const hide = (target, prop, getter) => {
    try { Object.defineProperty(target, prop, { get: getter, configurable: true }); } catch (e) {}
  };

  Object.defineProperty(nav, 'platform', { get: () => fp.platform });
  Object.defineProperty(nav, 'deviceMemory', { get: () => fp.deviceMemory });
  Object.defineProperty(nav, 'hardwareConcurrency', { get: () => fp.hardwareConcurrency });
  Object.defineProperty(nav, 'maxTouchPoints', { get: () => fp.maxTouchPoints });
  Object.defineProperty(nav, 'webdriver', { get: () => false });
  Object.defineProperty(nav, 'language', { get: () => fp.language });
  Object.defineProperty(nav, 'languages', { get: () => fp.languages });
  Object.defineProperty(nav, 'vendor', { get: () => 'Google Inc.' });
  Object.defineProperty(nav, 'productSub', { get: () => '20030107' });

  Object.defineProperty(scr, 'width', { get: () => fp.viewport.width });
  Object.defineProperty(scr, 'availWidth', { get: () => fp.viewport.width });
  Object.defineProperty(scr, 'height', { get: () => fp.viewport.height });
  Object.defineProperty(scr, 'availHeight', { get: () => Math.max(fp.viewport.height - 60, 0) });
  Object.defineProperty(scr, 'colorDepth', { get: () => fp.colorDepth });
  Object.defineProperty(scr, 'pixelDepth', { get: () => fp.colorDepth });
  Object.defineProperty(win, 'devicePixelRatio', { get: () => fp.pixelRatio });
  Object.defineProperty(win, 'outerWidth', { get: () => fp.viewport.width });
  Object.defineProperty(win, 'outerHeight', { get: () => fp.viewport.height });

  try {
    const conn = nav.connection;
    if (conn) {
      hide(conn, 'effectiveType', () => '4g');
      hide(conn, 'rtt', () => 50);
      hide(conn, 'downlink', () => 10);
      hide(conn, 'saveData', () => false);
    } else {
      hide(nav, 'connection', () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }));
    }
  } catch (e) {}

  try {
    if (!win.chrome) win.chrome = {};
    const chrome = win.chrome;
    if (!chrome.runtime) chrome.runtime = {};
    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      };
    }
    if (typeof chrome.csi !== 'function') chrome.csi = function () { return {}; };
    if (typeof chrome.loadTimes !== 'function') chrome.loadTimes = function () { return {}; };
  } catch (e) {}

  try {
    const Perm = win.Permissions;
    if (Perm && Perm.prototype && typeof Perm.prototype.query === 'function') {
      const query = Perm.prototype.query;
      Perm.prototype.query = function (parameters) {
        if (parameters && parameters.name === 'notifications') {
          const state = typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'denied' : 'prompt';
          return Promise.resolve({ state: state, onchange: null });
        }
        return query.apply(this, arguments);
      };
    }
  } catch (e) {}

  try {
    const makeMime = (type, suffixes, description) => ({ type, suffixes, description, enabledPlugin: null });
    const plugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: [makeMime('application/pdf', 'pdf', 'Portable Document Format')] },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: [makeMime('application/pdf', 'pdf', 'Portable Document Format')] },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: [makeMime('application/pdf', 'pdf', 'Portable Document Format')] },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: [makeMime('application/pdf', 'pdf', 'Portable Document Format')] },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: [makeMime('application/pdf', 'pdf', 'Portable Document Format')] },
    ];
    const mimeTypes = [];
    plugins.forEach((p) => {
      p.length = p.mimeTypes.length;
      p.item = (i) => p.mimeTypes[i] || null;
      p.namedItem = (name) => p.mimeTypes.filter((m) => m.type === name)[0] || null;
      p.mimeTypes.forEach((m) => {
        m.enabledPlugin = p;
        if (!mimeTypes.some((x) => x.type === m.type)) mimeTypes.push(m);
      });
    });
    const pluginArray = { length: plugins.length };
    plugins.forEach((p, i) => {
      pluginArray[i] = p;
      if (win.Plugin && win.Plugin.prototype) Object.setPrototypeOf(p, win.Plugin.prototype);
    });
    pluginArray.item = (i) => plugins[i] || null;
    pluginArray.namedItem = (name) => plugins.filter((p) => p.name === name)[0] || null;
    pluginArray.refresh = () => {};
    if (win.PluginArray && win.PluginArray.prototype) Object.setPrototypeOf(pluginArray, win.PluginArray.prototype);
    const mimeArray = { length: mimeTypes.length };
    mimeTypes.forEach((m, i) => {
      mimeArray[i] = m;
      if (win.MimeType && win.MimeType.prototype) Object.setPrototypeOf(m, win.MimeType.prototype);
    });
    mimeArray.item = (i) => mimeTypes[i] || null;
    mimeArray.namedItem = (name) => mimeTypes.filter((m) => m.type === name)[0] || null;
    if (win.MimeTypeArray && win.MimeTypeArray.prototype) Object.setPrototypeOf(mimeArray, win.MimeTypeArray.prototype);
    Object.defineProperty(nav, 'plugins', { get: () => pluginArray });
    Object.defineProperty(nav, 'mimeTypes', { get: () => mimeArray });
  } catch (e) {}

  try {
    const brands = meta.brands;
    const fullVersionList = meta.fullVersionList;
    const uaData = {
      brands: brands,
      mobile: mobile,
      platform: meta.platform,
      getHighEntropyValues: (hints) => {
        const values = {
          brands: brands,
          fullVersionList: fullVersionList,
          mobile: mobile,
          platform: meta.platform,
          platformVersion: meta.platformVersion,
          architecture: meta.architecture,
          model: meta.model,
          bitness: meta.bitness,
          wow64: meta.wow64,
          formFactors: meta.formFactors,
          uaFullVersion: fullVersionList[0] ? fullVersionList[0].version : '',
        };
        const result = {};
        (hints || []).forEach((hint) => { result[hint] = values[hint]; });
        return Promise.resolve(result);
      },
    };
    const data = nav.userAgentData;
    if (data) {
      hide(data, 'brands', () => brands);
      hide(data, 'mobile', () => mobile);
      hide(data, 'platform', () => meta.platform);
      try {
        const original = typeof data.getHighEntropyValues === 'function' ? data.getHighEntropyValues.bind(data) : null;
        if (original) {
          data.getHighEntropyValues = (hints) =>
            original(hints).then((values) => Object.assign({}, values, {
              brands: brands,
              fullVersionList: fullVersionList,
              mobile: mobile,
              platform: meta.platform,
              platformVersion: meta.platformVersion,
              architecture: meta.architecture,
              model: meta.model,
              bitness: meta.bitness,
              wow64: meta.wow64,
              formFactors: meta.formFactors,
            }));
        }
      } catch (e) {}
    } else {
      if (win.NavigatorUAData && win.NavigatorUAData.prototype) {
        Object.setPrototypeOf(uaData, win.NavigatorUAData.prototype);
      }
      Object.defineProperty(nav, 'userAgentData', { get: () => uaData });
    }
  } catch (e) {}

  const origDTF = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (locales, options) {
    return new origDTF(locales, Object.assign({}, options, { timeZone: (options && options.timeZone) || fp.timezone }));
  };
  Intl.DateTimeFormat.prototype = origDTF.prototype;
  Intl.DateTimeFormat.supportedLocalesOf = origDTF.supportedLocalesOf;

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
      try {
        const ctx = this.getContext('2d');
        if (ctx && typeof document !== 'undefined') {
          const imgData = ctx.getImageData(0, 0, this.width, this.height);
          const data = imgData.data;
          const source = String(fp.userAgent) + '|' + String(fp.webglRenderer);
          let seed = 2166136261;
          for (let c = 0; c < source.length; c++) {
            seed ^= source.charCodeAt(c);
            seed = Math.imul(seed, 16777619);
          }
          seed = seed >>> 0;
          // Deterministic per-fingerprint perturbation: hashes stay stable across calls,
          // while still differing from the stock headless Chromium canvas output.
          for (let i = 0; i < data.length; i += 4) {
            let h = (i ^ seed) >>> 0;
            h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
            h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
            h = (h ^ (h >>> 16)) >>> 0;
            if (h % 100 === 0) data[i] = data[i] > 0 ? data[i] - 1 : 1;
          }
          ctx.putImageData(imgData, 0, 0);
        }
      } catch (e) {}
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
