/** Manages the proxy pool: rotation, health checking, and failure handling. */

import { ProxyConfig } from '../config/anon.config.js';
import { getLogger, DetectionEvent } from './DetectionLogger.js';

export interface ProxyHealth {
  proxy: ProxyConfig;
  successCount: number;
  failureCount: number;
  lastUsed: number;
  lastSuccess: number;
  lastFailure: number;
  consecutiveFailures: number;
  averageResponseTime: number;
  responseTimes: number[];
  isCoolingDown: boolean;
  cooldownUntil: number;
}

export interface ProxyPoolStats {
  totalProxies: number;
  healthyProxies: number;
  coolingDownProxies: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  averageResponseTime: number;
}

export type RotationStrategy = 'round-robin' | 'random' | 'least-used' | 'fastest';

export class ProxyManager {
  private pool: Map<string, ProxyHealth> = new Map();
  private currentIndex: number = 0;
  private rotationStrategy: RotationStrategy;
  private failureThreshold: number;
  private cooldownMs: number;
  private maxResponseTimes: number = 10;

  constructor(
    proxies: ProxyConfig[] = [],
    options: {
      rotationStrategy?: RotationStrategy;
      failureThreshold?: number;
      cooldownMs?: number;
    } = {},
  ) {
    this.rotationStrategy = options.rotationStrategy || 'round-robin';
    this.failureThreshold = options.failureThreshold || 3;
    this.cooldownMs = options.cooldownMs || 300000; // 5 minutes

    for (const proxy of proxies) {
      this.addProxy(proxy);
    }
  }

  addProxy(proxy: ProxyConfig): void {
    const key = proxy.url;
    if (!this.pool.has(key)) {
      this.pool.set(key, {
        proxy,
        successCount: 0,
        failureCount: 0,
        lastUsed: 0,
        lastSuccess: 0,
        lastFailure: 0,
        consecutiveFailures: 0,
        averageResponseTime: 0,
        responseTimes: [],
        isCoolingDown: false,
        cooldownUntil: 0,
      });
    }
  }

  removeProxy(proxyUrl: string): boolean {
    return this.pool.delete(proxyUrl);
  }

  getNextProxy(): ProxyConfig | null {
    const healthyProxies = this.getHealthyProxies();

    if (healthyProxies.length === 0) {
      // No healthy proxy: caller connects directly.
      return null;
    }

    let selected: ProxyConfig;

    switch (this.rotationStrategy) {
      case 'round-robin':
        selected = this.roundRobinSelect(healthyProxies);
        break;
      case 'random':
        selected = this.randomSelect(healthyProxies);
        break;
      case 'least-used':
        selected = this.leastUsedSelect(healthyProxies);
        break;
      case 'fastest':
        selected = this.fastestSelect(healthyProxies);
        break;
      default:
        selected = this.roundRobinSelect(healthyProxies);
    }

    const health = this.pool.get(selected.url);
    if (health) {
      health.lastUsed = Date.now();
    }

    return selected;
  }

  private roundRobinSelect(proxies: ProxyConfig[]): ProxyConfig {
    this.currentIndex = this.currentIndex % proxies.length;
    const selected = proxies[this.currentIndex]!;
    this.currentIndex++;
    return selected;
  }

  private randomSelect(proxies: ProxyConfig[]): ProxyConfig {
    const index = Math.floor(Math.random() * proxies.length);
    return proxies[index]!;
  }

  private leastUsedSelect(proxies: ProxyConfig[]): ProxyConfig {
    let leastUsed = proxies[0]!;
    let leastCount = Infinity;

    for (const proxy of proxies) {
      const health = this.pool.get(proxy.url);
      if (health && health.successCount + health.failureCount < leastCount) {
        leastCount = health.successCount + health.failureCount;
        leastUsed = proxy;
      }
    }

    return leastUsed;
  }

  private fastestSelect(proxies: ProxyConfig[]): ProxyConfig {
    let fastest = proxies[0]!;
    let fastestTime = Infinity;

    for (const proxy of proxies) {
      const health = this.pool.get(proxy.url);
      if (health && health.averageResponseTime > 0 && health.averageResponseTime < fastestTime) {
        fastestTime = health.averageResponseTime;
        fastest = proxy;
      }
    }

    return fastest;
  }

  reportSuccess(proxyUrl: string, responseTime: number): void {
    const health = this.pool.get(proxyUrl);
    if (!health) return;

    health.successCount++;
    health.lastSuccess = Date.now();
    health.consecutiveFailures = 0;
    health.isCoolingDown = false;
    health.cooldownUntil = 0;

    health.responseTimes.push(responseTime);
    if (health.responseTimes.length > this.maxResponseTimes) {
      health.responseTimes.shift();
    }
    health.averageResponseTime =
      health.responseTimes.reduce((a, b) => a + b, 0) / health.responseTimes.length;

    getLogger().log(DetectionEvent.PROXY_SUCCESS, {
      source: 'ProxyManager',
      proxy: proxyUrl,
      details: { responseTime },
    });
  }

  reportFailure(proxyUrl: string, error: Error): void {
    const health = this.pool.get(proxyUrl);
    if (!health) return;

    health.failureCount++;
    health.lastFailure = Date.now();
    health.consecutiveFailures++;

    if (health.consecutiveFailures >= this.failureThreshold) {
      health.isCoolingDown = true;
      health.cooldownUntil = Date.now() + this.cooldownMs;

      getLogger().log(DetectionEvent.PROXY_FAILURE, {
        source: 'ProxyManager',
        proxy: proxyUrl,
        error: error.message,
        details: {
          consecutiveFailures: health.consecutiveFailures,
          coolingDownUntil: new Date(health.cooldownUntil).toISOString(),
        },
      });
    }
  }

  getHealthyProxies(): ProxyConfig[] {
    const now = Date.now();
    const healthy: ProxyConfig[] = [];

    for (const [, health] of this.pool) {
      if (health.isCoolingDown && now >= health.cooldownUntil) {
        health.isCoolingDown = false;
        health.consecutiveFailures = 0;
      }

      if (!health.isCoolingDown) {
        healthy.push(health.proxy);
      }
    }

    return healthy;
  }

  rotateOnDetection(): ProxyConfig | null {
    const currentProxy = this.getCurrentProxy();

    if (currentProxy) {
      const health = this.pool.get(currentProxy.url);
      if (health) {
        health.isCoolingDown = true;
        health.cooldownUntil = Date.now() + this.cooldownMs;
        health.consecutiveFailures = this.failureThreshold;
      }

      getLogger().logProxyRotation(currentProxy.url, null, 'Ban detected - emergency rotation');
    }

    return this.getNextProxy();
  }

  private getCurrentProxy(): ProxyConfig | null {
    const healthyProxies = this.getHealthyProxies();
    if (healthyProxies.length === 0) return null;

    const index = (this.currentIndex - 1 + healthyProxies.length) % healthyProxies.length;
    return healthyProxies[index] || null;
  }

  async healthCheck(proxy: ProxyConfig): Promise<boolean> {
    // Does not test connectivity: only checks that proxy.url parses. A dead but well-formed
    // proxy passes, and refreshPool() relies on this for its cooldown decision. Dead
    // proxies are detected reactively via reportFailure()'s consecutive-failure cooldown.
    try {
      const url = new URL(proxy.url);
      return url.hostname.length > 0;
    } catch {
      return false;
    }
  }

  async refreshPool(): Promise<void> {
    const checks: Promise<void>[] = [];

    for (const [proxyUrl, health] of this.pool) {
      checks.push(
        this.healthCheck(health.proxy).then((isHealthy) => {
          if (!isHealthy) {
            health.isCoolingDown = true;
            health.cooldownUntil = Date.now() + this.cooldownMs;
          }
        }),
      );
    }

    await Promise.all(checks);
  }

  getStats(): ProxyPoolStats {
    const stats: ProxyPoolStats = {
      totalProxies: this.pool.size,
      healthyProxies: this.getHealthyProxies().length,
      coolingDownProxies: 0,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      averageResponseTime: 0,
    };

    let totalResponseTime = 0;
    let responseTimeCount = 0;

    for (const [, health] of this.pool) {
      if (health.isCoolingDown) {
        stats.coolingDownProxies++;
      }
      stats.totalSuccesses += health.successCount;
      stats.totalFailures += health.failureCount;

      if (health.averageResponseTime > 0) {
        totalResponseTime += health.averageResponseTime;
        responseTimeCount++;
      }
    }

    stats.totalRequests = stats.totalSuccesses + stats.totalFailures;
    stats.averageResponseTime = responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0;

    return stats;
  }

  getProxyHealth(proxyUrl: string): ProxyHealth | null {
    return this.pool.get(proxyUrl) || null;
  }

  setRotationStrategy(strategy: RotationStrategy): void {
    this.rotationStrategy = strategy;
  }

  setFailureThreshold(threshold: number): void {
    this.failureThreshold = threshold;
  }

  setCooldownMs(cooldownMs: number): void {
    this.cooldownMs = cooldownMs;
  }

  hasProxies(): boolean {
    return this.pool.size > 0;
  }

  getProxyCount(): number {
    return this.pool.size;
  }

  clearPool(): void {
    this.pool.clear();
    this.currentIndex = 0;
  }

  importFromUrls(urls: string[], type: ProxyConfig['type'] = 'http'): void {
    for (const url of urls) {
      this.addProxy({ url, type });
    }
  }
}

let proxyManagerInstance: ProxyManager | null = null;

export function getProxyManager(
  proxies?: ProxyConfig[],
  options?: {
    rotationStrategy?: RotationStrategy;
    failureThreshold?: number;
    cooldownMs?: number;
  },
): ProxyManager {
  if (!proxyManagerInstance) {
    proxyManagerInstance = new ProxyManager(proxies, options);
  }
  return proxyManagerInstance;
}

export function resetProxyManager(): void {
  proxyManagerInstance = null;
}
