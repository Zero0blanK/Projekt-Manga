import { UserAgentProfile } from '../config/anon.config.js';

interface HardwareProfile {
  viewport: { width: number; height: number };
  deviceMemory: number;
  hardwareConcurrency: number;
  maxTouchPoints: number;
}

const DESKTOP_HARDWARE: HardwareProfile = {
  viewport: { width: 1920, height: 1080 },
  deviceMemory: 8,
  hardwareConcurrency: 8,
  maxTouchPoints: 0,
};

const MOBILE_HARDWARE: HardwareProfile = {
  viewport: { width: 412, height: 915 },
  deviceMemory: 8,
  hardwareConcurrency: 8,
  maxTouchPoints: 5,
};

const IOS_HARDWARE: HardwareProfile = {
  viewport: { width: 390, height: 844 },
  deviceMemory: 4,
  hardwareConcurrency: 6,
  maxTouchPoints: 5,
};

function detectPlatform(ua: string): UserAgentProfile['platform'] | null {
  if (/iphone|ipad|ipod/i.test(ua)) {
    return 'iOS';
  }
  if (/android/i.test(ua)) {
    return 'Android';
  }
  if (/macintosh|mac os x/i.test(ua)) {
    return 'MacOS';
  }
  if (/windows nt/i.test(ua)) {
    return 'Windows';
  }
  if (/linux/i.test(ua)) {
    return 'Linux';
  }
  return null;
}

function detectBrowser(
  ua: string,
): { browserType: UserAgentProfile['browserType']; version: string } | null {
  let match = ua.match(/Edg\/([\d.]+)/);
  if (match) {
    return { browserType: 'Edge', version: match[1]! };
  }

  match = ua.match(/OPR\/([\d.]+)/);
  if (match) {
    // Opera UAs still carry a Chrome token; treat as Chrome-family rather than rejecting.
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
    return { browserType: 'Chrome', version: chromeMatch?.[1] || match[1]! };
  }

  match = ua.match(/Chrome\/([\d.]+)/);
  if (match) {
    return { browserType: 'Chrome', version: match[1]! };
  }

  match = ua.match(/Firefox\/([\d.]+)/);
  if (match) {
    return { browserType: 'Firefox', version: match[1]! };
  }

  match = ua.match(/Version\/([\d.]+).*Safari\//);
  if (match) {
    return { browserType: 'Safari', version: match[1]! };
  }

  return null;
}

function hardwareFor(platform: UserAgentProfile['platform'], mobile: boolean): HardwareProfile {
  if (platform === 'iOS') {
    return IOS_HARDWARE;
  }
  if (mobile) {
    return MOBILE_HARDWARE;
  }
  return DESKTOP_HARDWARE;
}

/**
 * Parse a raw User-Agent string into a UserAgentProfile with a plausible matching
 * hardware/viewport profile. Returns null for strings that don't look like a real
 * desktop/mobile browser (bots, crawlers, malformed strings, etc.).
 */
export function parseUserAgentString(ua: string): UserAgentProfile | null {
  const trimmed = ua.trim();
  if (trimmed.length < 20 || trimmed.length > 512) {
    return null;
  }

  const platform = detectPlatform(trimmed);
  const browser = detectBrowser(trimmed);
  if (!platform || !browser) {
    return null;
  }

  const mobile = platform === 'iOS' || platform === 'Android' || /Mobile/i.test(trimmed);
  const hardware = hardwareFor(platform, mobile);

  return {
    userAgent: trimmed,
    platform,
    browserType: browser.browserType,
    version: browser.version,
    mobile,
    ...hardware,
  };
}
