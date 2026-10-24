/** Coordinates all anti-detection components. */

import {
  AntiDetectionConfig,
  BrowserFingerprint,
  ProxyConfig,
  UserAgentProfile,
  getAntiDetectionConfig,
} from '../config/anon.config.js';
import { ProxyManager, getProxyManager } from './ProxyManager.js';
import { UserAgentManager, getUserAgentManager } from './UserAgentManager.js';
import { FingerprintManager, getFingerprintManager } from './FingerprintManager.js';
import { SessionManager, getSessionManager, Session } from './SessionManager.js';
import { HumanBehavior, getHumanBehavior } from './HumanBehavior.js';
import { DetectionLogger, getLogger, DetectionEvent } from './DetectionLogger.js';
import {
  BAN_PATTERNS,
  CLOUDFLARE_PATTERNS,
  CAPTCHA_PATTERNS,
  matchesAny,
} from '../utils/detectionPatterns.js';

export interface AntiDetectionContext {
  proxy: ProxyConfig | null;
  fingerprint: BrowserFingerprint;
  session: Session;
  userAgentProfile: UserAgentProfile;
}

export interface FetchResult {
  html: string;
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  headers: Record<string, string>;
  statusCode: number;
  wasBlocked: boolean;
  challengeSolved: boolean;
  proxyUsed: string | null;
  responseTime: number;
}

export class AntiDetectionOrchestrator {
  private static instance: AntiDetectionOrchestrator | null = null;

  private proxyManager: ProxyManager;
  private userAgentManager: UserAgentManager;
  private fingerprintManager: FingerprintManager;
  private sessionManager: SessionManager;
  private humanBehavior: HumanBehavior;
  private logger: DetectionLogger;
  private config: AntiDetectionConfig;
  private initialized: boolean = false;
  private sessionLoadPromise: Promise<void> | null = null;

  private constructor(config: AntiDetectionConfig) {
    this.config = config;

    this.proxyManager = getProxyManager(config.proxies, {
      rotationStrategy: config.rotation.strategy,
      failureThreshold: config.rotation.failureThreshold,
      cooldownMs: config.rotation.cooldownMs,
    });

    this.userAgentManager = getUserAgentManager(config.userAgents);
    this.userAgentManager.startRemoteRefresh();
    this.fingerprintManager = getFingerprintManager(config.fingerprint);
    this.sessionManager = getSessionManager(config.session);
    this.sessionManager.startAutosave();
    this.humanBehavior = getHumanBehavior(config.delays);
    this.logger = getLogger(config.logging);

    this.initialized = true;
  }

  static getInstance(): AntiDetectionOrchestrator {
    if (!AntiDetectionOrchestrator.instance) {
      const config = getAntiDetectionConfig();
      AntiDetectionOrchestrator.instance = new AntiDetectionOrchestrator(config);
    }
    return AntiDetectionOrchestrator.instance;
  }

  /**
   * Initialize with custom config.
   *
   * `shutdown()` flushes sessions and logs to disk asynchronously and must finish before
   * the replacement is built: the new SessionManager reads the sessions.json the old one is
   * still writing, and interleaving corrupts or drops session state.
   *
   * Only the orchestrator is replaced. The managers it wires up (ProxyManager,
   * UserAgentManager, FingerprintManager, SessionManager, HumanBehavior, DetectionLogger)
   * are process-wide singletons that `shutdown()` does not reset, and their `getX(config)`
   * getters ignore a new config once built. To apply new config, call the matching
   * `resetX()` first (`resetProxyManager`, `resetUserAgentManager`,
   * `resetFingerprintManager`, `resetSessionManager`, `resetHumanBehavior`, `resetLogger`).
   */
  static async initialize(config: AntiDetectionConfig): Promise<AntiDetectionOrchestrator> {
    if (AntiDetectionOrchestrator.instance) {
      await AntiDetectionOrchestrator.instance.shutdown();
    }
    AntiDetectionOrchestrator.instance = new AntiDetectionOrchestrator(config);
    return AntiDetectionOrchestrator.instance;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async getContext(): Promise<AntiDetectionContext> {
    await this.ensureSessionLoaded();

    const proxy = this.proxyManager.getNextProxy();

    const userAgentProfile = this.userAgentManager.getCurrentProfile();

    const fingerprint = this.fingerprintManager.generateFingerprint(userAgentProfile);

    const session = this.sessionManager.getOrCreateSession(proxy?.url || null, fingerprint);

    this.logger.debug('Created anti-detection context', {
      proxy: proxy?.url || 'direct',
      userAgent: userAgentProfile.userAgent.substring(0, 50),
      sessionId: session.id,
    });

    return {
      proxy,
      fingerprint,
      session,
      userAgentProfile,
    };
  }

  private async ensureSessionLoaded(): Promise<void> {
    if (!this.config.session.persistSessions) {
      return;
    }

    if (!this.sessionLoadPromise) {
      this.sessionLoadPromise = this.sessionManager.loadFromStorage();
    }

    await this.sessionLoadPromise;
  }

  /**
   * Reports a successful request. Pass the elapsed request time so the 'fastest' proxy
   * rotation strategy has data to select on.
   */
  reportSuccess(context: AntiDetectionContext, responseTimeMs: number = 0): void {
    if (context.proxy) {
      this.proxyManager.reportSuccess(context.proxy.url, responseTimeMs);
    }

    this.logger.log(DetectionEvent.REQUEST_SUCCESS, {
      source: 'Orchestrator',
      proxy: context.proxy?.url,
      details: {
        sessionId: context.session.id,
        responseTimeMs,
      },
    });
  }

  reportFailure(context: AntiDetectionContext, error: Error): void {
    if (context.proxy) {
      this.proxyManager.reportFailure(context.proxy.url, error);
    }

    this.logger.log(DetectionEvent.REQUEST_FAILURE, {
      source: 'Orchestrator',
      proxy: context.proxy?.url,
      error: error.message,
      details: {
        sessionId: context.session.id,
      },
    });
  }

  reportBan(context: AntiDetectionContext, banType: string): void {
    this.logger.logBanDetection('Orchestrator', 'unknown', banType);

    if (this.config.rotation.rotateOnFailure) {
      this.emergencyRotate(context);
    }
  }

  async emergencyRotate(context: AntiDetectionContext): Promise<AntiDetectionContext> {
    this.logger.log(DetectionEvent.EMERGENCY_ROTATION, {
      source: 'Orchestrator',
      proxy: context.proxy?.url,
      details: {
        reason: 'Detection triggered emergency rotation',
      },
    });

    const newProxy = this.proxyManager.rotateOnDetection();

    const newFingerprint = this.fingerprintManager.rotateFingerprint();

    const newSession = this.sessionManager.rotateSession(newProxy?.url || null);

    const newProfile = this.userAgentManager.rotateProfile();

    return {
      proxy: newProxy,
      fingerprint: newFingerprint,
      session: newSession,
      userAgentProfile: newProfile,
    };
  }

  isBanResponse(html: string, statusCode: number): boolean {
    if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
      return true;
    }

    return matchesAny(BAN_PATTERNS, html);
  }

  isCloudflareChallenge(html: string): boolean {
    return matchesAny(CLOUDFLARE_PATTERNS, html);
  }

  isCaptchaPage(html: string): boolean {
    return matchesAny(CAPTCHA_PATTERNS, html);
  }

  isRateLimited(statusCode: number, headers: Record<string, string>): boolean {
    if (statusCode === 429) {
      return true;
    }

    const retryAfter = headers['retry-after'] || headers['Retry-After'];
    if (retryAfter) {
      return true;
    }

    const rateLimit = headers['x-ratelimit-remaining'] || headers['X-RateLimit-Remaining'];
    if (rateLimit === '0') {
      return true;
    }

    return false;
  }

  async waitRandomDelay(): Promise<void> {
    await this.humanBehavior.waitForBurstProtection();
    await this.humanBehavior.randomDelay();
    this.humanBehavior.recordRequest();
  }

  getProxyManager(): ProxyManager {
    return this.proxyManager;
  }

  getUserAgentManager(): UserAgentManager {
    return this.userAgentManager;
  }

  getFingerprintManager(): FingerprintManager {
    return this.fingerprintManager;
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getHumanBehavior(): HumanBehavior {
    return this.humanBehavior;
  }

  getLogger(): DetectionLogger {
    return this.logger;
  }

  getConfig(): AntiDetectionConfig {
    return this.config;
  }

  updateConfig(config: Partial<AntiDetectionConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      fingerprint: {
        ...this.config.fingerprint,
        ...config.fingerprint,
      },
      delays: {
        ...this.config.delays,
        ...config.delays,
      },
      session: {
        ...this.config.session,
        ...config.session,
      },
      logging: {
        ...this.config.logging,
        ...config.logging,
      },
      rotation: {
        ...this.config.rotation,
        ...config.rotation,
      },
    };

    this.fingerprintManager.updateConfig(this.config.fingerprint);
    this.humanBehavior.updateConfig(this.config.delays);
    this.sessionManager.updateConfig(this.config.session);

    if (config.rotation) {
      if (config.rotation.strategy) {
        this.proxyManager.setRotationStrategy(config.rotation.strategy);
      }
      if (config.rotation.failureThreshold) {
        this.proxyManager.setFailureThreshold(config.rotation.failureThreshold);
      }
      if (config.rotation.cooldownMs) {
        this.proxyManager.setCooldownMs(config.rotation.cooldownMs);
      }
    }
  }

  addProxies(proxies: ProxyConfig[]): void {
    for (const proxy of proxies) {
      this.proxyManager.addProxy(proxy);
    }
  }

  async shutdown(): Promise<void> {
    this.userAgentManager.stopRemoteRefresh();
    this.sessionManager.stopAutosave();

    await this.sessionManager.saveToStorage();

    await this.logger.flush();

    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Resets the singleton (for testing). Awaits the shutdown flush, as `initialize` does.
   */
  static async reset(): Promise<void> {
    if (AntiDetectionOrchestrator.instance) {
      await AntiDetectionOrchestrator.instance.shutdown();
      AntiDetectionOrchestrator.instance = null;
    }
  }
}

export function getOrchestrator(): AntiDetectionOrchestrator {
  return AntiDetectionOrchestrator.getInstance();
}
