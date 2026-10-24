/** Manages user-agent rotation with matching browser profiles. */

import {
  UserAgentProfile,
  REALISTIC_USER_AGENT_PROFILES,
  BrowserFingerprint,
} from '../config/anon.config.js';
import { fetchRemoteUserAgentString } from './RemoteUserAgent.js';
import { parseUserAgentString } from '../utils/userAgentParser.js';

const DEFAULT_REMOTE_REFRESH_INTERVAL_MS = 3600000; // 1 hour, matches apps/server's default

export class UserAgentManager {
  private profiles: UserAgentProfile[];
  private currentProfile: UserAgentProfile | null = null;
  private currentIndex: number = 0;
  private lastRotation: number = 0;
  private rotationInterval: number;
  private remoteRefreshTimer: NodeJS.Timeout | null = null;
  private remoteRefreshStarted: boolean = false;
  private usingRemoteProfile: boolean = false;

  constructor(
    profiles: UserAgentProfile[] = REALISTIC_USER_AGENT_PROFILES,
    rotationIntervalMs: number = 3600000, // 1 hour default
  ) {
    this.profiles = [...profiles];
    this.rotationInterval = rotationIntervalMs;
    this.currentProfile = this.getRandomProfile();
  }

  /**
   * Fetch the latest real-world User-Agent from the configured remote source
   * (USER_AGENT_SOURCE_URL) and merge it into the rotation pool. No-ops when
   * the source isn't configured or the fetch fails — the static pool remains
   * as fallback either way.
   */
  async refreshFromRemote(): Promise<boolean> {
    try {
      const ua = await fetchRemoteUserAgentString();
      if (!ua) {
        return false;
      }

      const profile = parseUserAgentString(ua);
      if (!profile) {
        return false;
      }

      this.upsertProfile(profile);
      this.usingRemoteProfile = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replace any existing profile for the same platform/browser pairing so the
   * pool doesn't accumulate stale versions of the same browser over time.
   */
  private upsertProfile(profile: UserAgentProfile): void {
    this.profiles = this.profiles.filter(
      (p) => !(p.platform === profile.platform && p.browserType === profile.browserType),
    );
    this.profiles.unshift(profile);
  }

  /**
   * Start periodic background refresh from the remote UA source. Safe to call
   * unconditionally — it's a no-op when USER_AGENT_SOURCE_URL isn't set.
   */
  startRemoteRefresh(intervalMs?: number): void {
    if (this.remoteRefreshStarted || !process.env.USER_AGENT_SOURCE_URL?.trim()) {
      return;
    }
    this.remoteRefreshStarted = true;

    void this.refreshFromRemote();

    const envInterval = Number.parseInt(
      process.env.USER_AGENT_REFRESH_INTERVAL_MS?.trim() || '',
      10,
    );
    const refreshIntervalMs =
      intervalMs ??
      (Number.isFinite(envInterval) && envInterval > 0
        ? envInterval
        : DEFAULT_REMOTE_REFRESH_INTERVAL_MS);

    this.remoteRefreshTimer = setInterval(() => {
      void this.refreshFromRemote();
    }, refreshIntervalMs);
    this.remoteRefreshTimer.unref?.();
  }

  stopRemoteRefresh(): void {
    if (this.remoteRefreshTimer) {
      clearInterval(this.remoteRefreshTimer);
    }
    this.remoteRefreshTimer = null;
    this.remoteRefreshStarted = false;
  }

  isUsingRemoteProfile(): boolean {
    return this.usingRemoteProfile;
  }

  getCurrentProfile(): UserAgentProfile {
    const now = Date.now();
    if (!this.currentProfile || now - this.lastRotation > this.rotationInterval) {
      this.rotateProfile();
    }
    return this.currentProfile!;
  }

  rotateProfile(): UserAgentProfile {
    this.currentIndex = (this.currentIndex + 1) % this.profiles.length;
    this.currentProfile = this.profiles[this.currentIndex]!;
    this.lastRotation = Date.now();
    return this.currentProfile;
  }

  getRandomProfile(): UserAgentProfile {
    const index = Math.floor(Math.random() * this.profiles.length);
    this.currentIndex = index;
    this.currentProfile = this.profiles[index]!;
    this.lastRotation = Date.now();
    return this.currentProfile;
  }

  getDesktopProfile(): UserAgentProfile {
    const desktopProfiles = this.profiles.filter((p) => !p.mobile);
    if (desktopProfiles.length === 0) {
      return this.getRandomProfile();
    }
    const index = Math.floor(Math.random() * desktopProfiles.length);
    this.currentProfile = desktopProfiles[index]!;
    this.lastRotation = Date.now();
    return this.currentProfile;
  }

  getMobileProfile(): UserAgentProfile {
    const mobileProfiles = this.profiles.filter((p) => p.mobile);
    if (mobileProfiles.length === 0) {
      return this.getRandomProfile();
    }
    const index = Math.floor(Math.random() * mobileProfiles.length);
    this.currentProfile = mobileProfiles[index]!;
    this.lastRotation = Date.now();
    return this.currentProfile;
  }

  getProfileForPlatform(
    platform: 'Windows' | 'MacOS' | 'Linux' | 'Android' | 'iOS',
  ): UserAgentProfile {
    const platformProfiles = this.profiles.filter((p) => p.platform === platform);
    if (platformProfiles.length === 0) {
      return this.getRandomProfile();
    }
    const index = Math.floor(Math.random() * platformProfiles.length);
    this.currentProfile = platformProfiles[index]!;
    this.lastRotation = Date.now();
    return this.currentProfile;
  }

  getProfileForBrowser(browserType: 'Chrome' | 'Firefox' | 'Safari' | 'Edge'): UserAgentProfile {
    const browserProfiles = this.profiles.filter((p) => p.browserType === browserType);
    if (browserProfiles.length === 0) {
      return this.getRandomProfile();
    }
    const index = Math.floor(Math.random() * browserProfiles.length);
    this.currentProfile = browserProfiles[index]!;
    this.lastRotation = Date.now();
    return this.currentProfile;
  }

  getMatchingFingerprint(
    profile: UserAgentProfile,
    timezone: string = 'America/New_York',
    language: string = 'en-US',
  ): BrowserFingerprint {
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

    let webglVendor: string;
    let webglRenderer: string;

    if (profile.platform === 'MacOS') {
      webglVendor = 'Apple Inc.';
      webglRenderer = Math.random() > 0.5 ? 'Apple M1 Pro' : 'Apple M2';
    } else if (profile.platform === 'Windows') {
      const vendors = ['Google Inc. (NVIDIA)', 'Google Inc. (Intel)', 'Google Inc. (AMD)'];
      const renderers = [
        'ANGLE (NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0)',
        'ANGLE (NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
        'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
        'ANGLE (Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)',
        'ANGLE (AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0)',
      ];
      webglVendor = vendors[Math.floor(Math.random() * vendors.length)]!;
      webglRenderer = renderers[Math.floor(Math.random() * renderers.length)]!;
    } else {
      webglVendor = 'Mesa';
      webglRenderer = 'Mesa Intel(R) UHD Graphics 630';
    }

    return {
      userAgent: profile.userAgent,
      platform,
      viewport: profile.viewport,
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
  }

  addProfiles(profiles: UserAgentProfile[]): void {
    this.profiles.push(...profiles);
  }

  getAllProfiles(): UserAgentProfile[] {
    return [...this.profiles];
  }

  getProfileCount(): number {
    return this.profiles.length;
  }

  setRotationInterval(intervalMs: number): void {
    this.rotationInterval = intervalMs;
  }
}

let userAgentManagerInstance: UserAgentManager | null = null;

export function getUserAgentManager(
  profiles?: UserAgentProfile[],
  rotationIntervalMs?: number,
): UserAgentManager {
  if (!userAgentManagerInstance) {
    userAgentManagerInstance = new UserAgentManager(profiles, rotationIntervalMs);
  }
  return userAgentManagerInstance;
}

export function resetUserAgentManager(): void {
  userAgentManagerInstance?.stopRemoteRefresh();
  userAgentManagerInstance = null;
}
