/** Structured logging for anti-detection events. */

import * as fs from 'fs';
import * as path from 'path';
import { LoggingConfig } from '../config/anon.config.js';

export enum DetectionEvent {
  PROXY_ROTATION = 'proxy_rotation',
  PROXY_FAILURE = 'proxy_failure',
  PROXY_SUCCESS = 'proxy_success',
  BAN_DETECTED = 'ban_detected',
  CLOUDFLARE_CHALLENGE = 'cloudflare_challenge',
  CAPTCHA_DETECTED = 'captcha_detected',
  FINGERPRINT_ROTATION = 'fingerprint_rotation',
  SESSION_ROTATION = 'session_rotation',
  RATE_LIMIT_HIT = 'rate_limit_hit',
  REQUEST_SUCCESS = 'request_success',
  REQUEST_FAILURE = 'request_failure',
  EMERGENCY_ROTATION = 'emergency_rotation',
}

export interface LogEntry {
  timestamp: number;
  isoTime: string;
  event: DetectionEvent;
  source: string;
  url?: string;
  proxy?: string;
  fingerprint?: string;
  details: Record<string, unknown>;
  error?: string;
  stack?: string;
}

export interface DetectionStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  bansDetected: number;
  cloudflaresChallenges: number;
  captchasDetected: number;
  proxyRotations: number;
  fingerprintRotations: number;
  sessionRotations: number;
  rateLimitsHit: number;
}

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Event-to-console-level lookup used by log().
const CONSOLE_LEVEL_BY_EVENT: Partial<Record<DetectionEvent, keyof typeof LOG_LEVELS>> = {
  [DetectionEvent.BAN_DETECTED]: 'error',
  [DetectionEvent.CAPTCHA_DETECTED]: 'error',
  [DetectionEvent.REQUEST_FAILURE]: 'error',
  [DetectionEvent.PROXY_FAILURE]: 'error',
  [DetectionEvent.CLOUDFLARE_CHALLENGE]: 'warn',
  [DetectionEvent.RATE_LIMIT_HIT]: 'warn',
  [DetectionEvent.EMERGENCY_ROTATION]: 'warn',
};

export class DetectionLogger {
  private config: LoggingConfig;
  private writeStream: fs.WriteStream | null = null;
  private stats: DetectionStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    bansDetected: 0,
    cloudflaresChallenges: 0,
    captchasDetected: 0,
    proxyRotations: 0,
    fingerprintRotations: 0,
    sessionRotations: 0,
    rateLimitsHit: 0,
  };
  private recentBans: LogEntry[] = [];
  private maxRecentBans = 100;

  constructor(config: LoggingConfig) {
    this.config = config;
    this.initializeFileLogging();
  }

  private initializeFileLogging(): void {
    if (this.config.outputPath) {
      const dir = path.dirname(this.config.outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.writeStream = fs.createWriteStream(this.config.outputPath, {
        flags: 'a',
      });
    }
  }

  private shouldLog(level: keyof typeof LOG_LEVELS): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.logLevel];
  }

  private formatEntry(entry: LogEntry): string {
    const prefix = `[${entry.isoTime}] [${entry.event.toUpperCase()}]`;
    const source = entry.source ? ` [${entry.source}]` : '';
    const url = entry.url ? ` ${entry.url}` : '';
    const proxy = entry.proxy ? ` proxy=${entry.proxy}` : '';
    const details =
      Object.keys(entry.details).length > 0 ? ` ${JSON.stringify(entry.details)}` : '';
    const error = entry.error ? ` ERROR: ${entry.error}` : '';

    return `${prefix}${source}${url}${proxy}${details}${error}`;
  }

  private writeToFile(entry: LogEntry): void {
    if (this.writeStream) {
      this.writeStream.write(JSON.stringify(entry) + '\n');
    }
  }

  private createEntry(
    event: DetectionEvent,
    data: Partial<Omit<LogEntry, 'timestamp' | 'isoTime' | 'event'>>,
  ): LogEntry {
    const now = Date.now();
    return {
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      event,
      source: data.source || 'unknown',
      url: data.url,
      proxy: data.proxy,
      fingerprint: data.fingerprint,
      details: data.details || {},
      error: data.error,
      stack: data.stack,
    };
  }

  log(
    event: DetectionEvent,
    data: Partial<Omit<LogEntry, 'timestamp' | 'isoTime' | 'event'>>,
  ): void {
    const entry = this.createEntry(event, data);

    this.updateStats(event);

    if (event === DetectionEvent.BAN_DETECTED) {
      this.recentBans.push(entry);
      if (this.recentBans.length > this.maxRecentBans) {
        this.recentBans.shift();
      }
    }

    // Format only when the level clears the threshold: this runs on every request and
    // formatting JSON.stringifies details.
    const level = CONSOLE_LEVEL_BY_EVENT[event] ?? 'info';
    if (this.shouldLog(level)) {
      const formatted = this.formatEntry(entry);
      switch (level) {
        case 'error':
          console.error(formatted);
          break;
        case 'warn':
          console.warn(formatted);
          break;
        default:
          console.log(formatted);
      }
    }

    this.writeToFile(entry);
  }

  private updateStats(event: DetectionEvent): void {
    switch (event) {
      case DetectionEvent.REQUEST_SUCCESS:
        this.stats.totalRequests++;
        this.stats.successfulRequests++;
        break;
      case DetectionEvent.REQUEST_FAILURE:
        this.stats.totalRequests++;
        this.stats.failedRequests++;
        break;
      case DetectionEvent.BAN_DETECTED:
        this.stats.bansDetected++;
        break;
      case DetectionEvent.CLOUDFLARE_CHALLENGE:
        this.stats.cloudflaresChallenges++;
        break;
      case DetectionEvent.CAPTCHA_DETECTED:
        this.stats.captchasDetected++;
        break;
      case DetectionEvent.PROXY_ROTATION:
        this.stats.proxyRotations++;
        break;
      case DetectionEvent.FINGERPRINT_ROTATION:
        this.stats.fingerprintRotations++;
        break;
      case DetectionEvent.SESSION_ROTATION:
        this.stats.sessionRotations++;
        break;
      case DetectionEvent.RATE_LIMIT_HIT:
        this.stats.rateLimitsHit++;
        break;
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(`[DEBUG] ${message}`, data || '');
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.log(`[INFO] ${message}`, data || '');
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN] ${message}`, data || '');
    }
  }

  error(message: string, error?: Error, data?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      console.error(`[ERROR] ${message}`, error?.message || '', data || '');
      if (error?.stack) {
        console.error(error.stack);
      }
    }
  }

  logBanDetection(source: string, url: string, reason: string): void {
    if (this.config.logBanDetection) {
      this.log(DetectionEvent.BAN_DETECTED, {
        source,
        url,
        details: { reason },
      });
    }
  }

  logProxyRotation(oldProxy: string | null, newProxy: string | null, reason: string): void {
    if (this.config.logProxyRotation) {
      this.log(DetectionEvent.PROXY_ROTATION, {
        source: 'ProxyManager',
        details: { oldProxy, newProxy, reason },
      });
    }
  }

  logCloudflareChallenge(url: string, solved: boolean, attempts?: number): void {
    this.log(DetectionEvent.CLOUDFLARE_CHALLENGE, {
      source: 'Puppeteer',
      url,
      details: { solved, attempts },
    });
  }

  logFingerprintRotation(reason: string): void {
    if (this.config.logFingerprintChanges) {
      this.log(DetectionEvent.FINGERPRINT_ROTATION, {
        source: 'FingerprintManager',
        details: { reason },
      });
    }
  }

  logSessionRotation(proxyUrl: string | null, reason: string): void {
    this.log(DetectionEvent.SESSION_ROTATION, {
      source: 'SessionManager',
      proxy: proxyUrl || 'direct',
      details: { reason },
    });
  }

  logRateLimitHit(source: string, url: string): void {
    this.log(DetectionEvent.RATE_LIMIT_HIT, {
      source,
      url,
      details: {},
    });
  }

  logRequestSuccess(source: string, url: string, responseTime: number, proxy?: string): void {
    this.log(DetectionEvent.REQUEST_SUCCESS, {
      source,
      url,
      proxy,
      details: { responseTime },
    });
  }

  logRequestFailure(source: string, url: string, error: Error, proxy?: string): void {
    this.log(DetectionEvent.REQUEST_FAILURE, {
      source,
      url,
      proxy,
      error: error.message,
      stack: error.stack,
      details: {},
    });
  }

  getRecentBans(minutes: number = 10): LogEntry[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.recentBans.filter((entry) => entry.timestamp >= cutoff);
  }

  getStats(): DetectionStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      bansDetected: 0,
      cloudflaresChallenges: 0,
      captchasDetected: 0,
      proxyRotations: 0,
      fingerprintRotations: 0,
      sessionRotations: 0,
      rateLimitsHit: 0,
    };
  }

  async flush(): Promise<void> {
    if (this.writeStream) {
      return new Promise((resolve, reject) => {
        this.writeStream!.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  dispose(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}

let loggerInstance: DetectionLogger | null = null;

export function getLogger(config?: LoggingConfig): DetectionLogger {
  if (!loggerInstance && config) {
    loggerInstance = new DetectionLogger(config);
  }
  if (!loggerInstance) {
    loggerInstance = new DetectionLogger({
      logLevel: 'info',
      logBanDetection: true,
      logProxyRotation: true,
      logFingerprintChanges: false,
    });
  }
  return loggerInstance;
}

export function resetLogger(): void {
  if (loggerInstance) {
    loggerInstance.dispose();
    loggerInstance = null;
  }
}
