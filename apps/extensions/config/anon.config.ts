// Anti-detection configuration: types, defaults (user agent profiles, timezones, WebGL
// pools), env-driven proxy/rotation loading, and the get/set/reset accessors.

export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyConfig {
  url: string;
  type: ProxyType;
  location?: string;
  maxConcurrent?: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface UserAgentProfile {
  userAgent: string;
  platform: 'Windows' | 'MacOS' | 'Linux' | 'Android' | 'iOS';
  browserType: 'Chrome' | 'Firefox' | 'Safari' | 'Edge';
  version: string;
  mobile: boolean;
  viewport: { width: number; height: number };
  deviceMemory: number;
  hardwareConcurrency: number;
  maxTouchPoints: number;
}

export interface BrowserFingerprint {
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  deviceMemory: number;
  hardwareConcurrency: number;
  maxTouchPoints: number;
  timezone: string;
  language: string;
  languages: string[];
  colorDepth: number;
  pixelRatio: number;
  webglVendor: string;
  webglRenderer: string;
}

export interface FingerprintConfig {
  randomizeViewport: boolean;
  viewportRange: {
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
  };
  randomizeTimezone: boolean;
  timezones: string[];
  randomizeLanguage: boolean;
  languages: string[];
  randomizeWebGL: boolean;
  randomizeCanvas: boolean;
  rotateOnFailure: boolean;
}

export interface DelayConfig {
  minRequestDelay: number;
  maxRequestDelay: number;
  pageLoadDelay: { min: number; max: number };
  scrollDelay: { min: number; max: number };
  clickDelay: { min: number; max: number };
  burstProtection: {
    maxRequestsPerMinute: number;
    cooldownMs: number;
  };
}

export interface SessionConfig {
  isolatePerProxy: boolean;
  cookieRotationInterval: number;
  maxSessionAge: number;
  persistSessions: boolean;
  sessionStoragePath: string;
}

export interface LoggingConfig {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logBanDetection: boolean;
  logProxyRotation: boolean;
  logFingerprintChanges: boolean;
  outputPath?: string;
}

export interface AntiDetectionConfig {
  enabled: boolean;
  proxies: ProxyConfig[];
  userAgents: UserAgentProfile[];
  fingerprint: FingerprintConfig;
  delays: DelayConfig;
  session: SessionConfig;
  logging: LoggingConfig;
  rotation: {
    strategy: 'round-robin' | 'random' | 'least-used' | 'fastest';
    rotateOnFailure: boolean;
    failureThreshold: number;
    cooldownMs: number;
  };
}

export const REALISTIC_USER_AGENT_PROFILES: UserAgentProfile[] = [
  // Chrome on Windows
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Windows',
    browserType: 'Chrome',
    version: '122',
    mobile: false,
    viewport: { width: 1920, height: 1080 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    platform: 'Windows',
    browserType: 'Chrome',
    version: '121',
    mobile: false,
    viewport: { width: 1536, height: 864 },
    deviceMemory: 8,
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Windows',
    browserType: 'Chrome',
    version: '120',
    mobile: false,
    viewport: { width: 1366, height: 768 },
    deviceMemory: 4,
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
  },
  // Chrome on MacOS
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'MacOS',
    browserType: 'Chrome',
    version: '122',
    mobile: false,
    viewport: { width: 1440, height: 900 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    platform: 'MacOS',
    browserType: 'Chrome',
    version: '121',
    mobile: false,
    viewport: { width: 2560, height: 1440 },
    deviceMemory: 16,
    hardwareConcurrency: 10,
    maxTouchPoints: 0,
  },
  // Firefox on Windows
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    platform: 'Windows',
    browserType: 'Firefox',
    version: '123',
    mobile: false,
    viewport: { width: 1920, height: 1080 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
  },
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    platform: 'Windows',
    browserType: 'Firefox',
    version: '122',
    mobile: false,
    viewport: { width: 1536, height: 864 },
    deviceMemory: 8,
    hardwareConcurrency: 6,
    maxTouchPoints: 0,
  },
  // Firefox on MacOS
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
    platform: 'MacOS',
    browserType: 'Firefox',
    version: '123',
    mobile: false,
    viewport: { width: 1440, height: 900 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
  },
  // Edge on Windows
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    platform: 'Windows',
    browserType: 'Edge',
    version: '122',
    mobile: false,
    viewport: { width: 1920, height: 1080 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
    platform: 'Windows',
    browserType: 'Edge',
    version: '121',
    mobile: false,
    viewport: { width: 1366, height: 768 },
    deviceMemory: 4,
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
  },
  // Safari on MacOS
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    platform: 'MacOS',
    browserType: 'Safari',
    version: '17.3',
    mobile: false,
    viewport: { width: 1440, height: 900 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    platform: 'MacOS',
    browserType: 'Safari',
    version: '17.2',
    mobile: false,
    viewport: { width: 2560, height: 1440 },
    deviceMemory: 16,
    hardwareConcurrency: 10,
    maxTouchPoints: 0,
  },
  // Chrome on Linux
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Linux',
    browserType: 'Chrome',
    version: '122',
    mobile: false,
    viewport: { width: 1920, height: 1080 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
  },
  // Firefox on Linux
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0',
    platform: 'Linux',
    browserType: 'Firefox',
    version: '123',
    mobile: false,
    viewport: { width: 1920, height: 1080 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
  },
  // Mobile Chrome on Android
  {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    platform: 'Android',
    browserType: 'Chrome',
    version: '122',
    mobile: true,
    viewport: { width: 412, height: 915 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 5,
  },
  {
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    platform: 'Android',
    browserType: 'Chrome',
    version: '122',
    mobile: true,
    viewport: { width: 360, height: 780 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 5,
  },
  // Safari on iOS
  {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
    platform: 'iOS',
    browserType: 'Safari',
    version: '17.3',
    mobile: true,
    viewport: { width: 390, height: 844 },
    deviceMemory: 4,
    hardwareConcurrency: 6,
    maxTouchPoints: 5,
  },
  {
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
    platform: 'iOS',
    browserType: 'Safari',
    version: '17.3',
    mobile: true,
    viewport: { width: 820, height: 1180 },
    deviceMemory: 8,
    hardwareConcurrency: 8,
    maxTouchPoints: 5,
  },
];

export const TIMEZONE_POOL: string[] = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Australia/Sydney',
];

export const WEBGL_VENDORS: string[] = [
  'Google Inc. (NVIDIA)',
  'Google Inc. (Intel)',
  'Google Inc. (AMD)',
  'Intel Inc.',
  'NVIDIA Corporation',
  'AMD',
];

export const WEBGL_RENDERERS: string[] = [
  'ANGLE (NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (AMD Radeon Graphics Direct3D11 vs_5_0 ps_5_0)',
  'Apple M1 Pro',
  'Apple M2',
  'Mesa Intel(R) UHD Graphics 630',
];

export const defaultAntiDetectionConfig: AntiDetectionConfig = {
  enabled: true,
  proxies: [],
  userAgents: REALISTIC_USER_AGENT_PROFILES,
  fingerprint: {
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
  },
  delays: {
    // Intentionally small: requests are already spaced by the axios rate-limit interceptor
    // (with adaptive backoff) and burstProtection below, so this is only extra jitter.
    minRequestDelay: 10,
    maxRequestDelay: 50,
    pageLoadDelay: { min: 10, max: 50 },
    scrollDelay: { min: 100, max: 500 },
    clickDelay: { min: 50, max: 200 },
    burstProtection: {
      maxRequestsPerMinute: 30,
      cooldownMs: 60000,
    },
  },
  session: {
    isolatePerProxy: true,
    cookieRotationInterval: 3600000, // 1 hour
    maxSessionAge: 86400000, // 24 hours
    persistSessions: true,
    sessionStoragePath: './data/sessions',
  },
  logging: {
    logLevel: 'info',
    logBanDetection: true,
    logProxyRotation: true,
    logFingerprintChanges: false,
  },
  rotation: {
    strategy: 'round-robin',
    rotateOnFailure: true,
    failureThreshold: 3,
    cooldownMs: 300000, // 5 minutes
  },
};

function parseProxyEntry(raw: string): ProxyConfig | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    const type: ProxyType =
      scheme === 'socks5' || scheme === 'socks4' || scheme === 'https'
        ? (scheme as ProxyType)
        : 'http';
    return { url: trimmed, type };
  } catch {
    return null;
  }
}

/** Loads a comma-separated proxy list from EXT_PROXY_LIST (e.g.
 *  "http://user:pass@host:1234,socks5://host:1080"). Without it the pool is empty
 *  and the orchestrator falls back to direct (proxy-less) requests. */
function loadProxiesFromEnv(): ProxyConfig[] {
  const raw = process.env.EXT_PROXY_LIST?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => parseProxyEntry(entry))
    .filter((proxy): proxy is ProxyConfig => proxy !== null);
}

function loadRotationConfigFromEnv(): AntiDetectionConfig['rotation'] {
  const validStrategies = ['round-robin', 'random', 'least-used', 'fastest'] as const;
  const strategyRaw = process.env.EXT_PROXY_ROTATION_STRATEGY?.trim();
  const strategy = (validStrategies as readonly string[]).includes(strategyRaw || '')
    ? (strategyRaw as (typeof validStrategies)[number])
    : 'round-robin';

  const failureThresholdRaw = Number.parseInt(
    process.env.EXT_PROXY_FAILURE_THRESHOLD?.trim() || '',
    10,
  );
  const cooldownMsRaw = Number.parseInt(process.env.EXT_PROXY_COOLDOWN_MS?.trim() || '', 10);

  return {
    strategy,
    rotateOnFailure: true,
    failureThreshold:
      Number.isFinite(failureThresholdRaw) && failureThresholdRaw > 0 ? failureThresholdRaw : 3,
    cooldownMs: Number.isFinite(cooldownMsRaw) && cooldownMsRaw > 0 ? cooldownMsRaw : 300000,
  };
}

let currentConfig: AntiDetectionConfig = {
  ...defaultAntiDetectionConfig,
  proxies: loadProxiesFromEnv(),
  rotation: loadRotationConfigFromEnv(),
};

export function getAntiDetectionConfig(): AntiDetectionConfig {
  return currentConfig;
}

export function setAntiDetectionConfig(config: Partial<AntiDetectionConfig>): void {
  currentConfig = {
    ...currentConfig,
    ...config,
    fingerprint: {
      ...currentConfig.fingerprint,
      ...config.fingerprint,
    },
    delays: {
      ...currentConfig.delays,
      ...config.delays,
    },
    session: {
      ...currentConfig.session,
      ...config.session,
    },
    logging: {
      ...currentConfig.logging,
      ...config.logging,
    },
    rotation: {
      ...currentConfig.rotation,
      ...config.rotation,
    },
  };
}

export function resetAntiDetectionConfig(): void {
  currentConfig = {
    ...defaultAntiDetectionConfig,
    proxies: loadProxiesFromEnv(),
    rotation: loadRotationConfigFromEnv(),
  };
}
