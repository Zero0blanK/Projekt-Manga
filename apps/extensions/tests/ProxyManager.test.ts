import { describe, it, expect } from 'vitest';
import { ProxyManager } from '../features/ProxyManager.js';
import type { ProxyConfig } from '../config/anon.config.js';

const proxies: ProxyConfig[] = [
  { url: 'http://proxy1.test:8080', type: 'http' },
  { url: 'http://proxy2.test:8080', type: 'http' },
  { url: 'http://proxy3.test:8080', type: 'http' },
];

describe('ProxyManager round-robin', () => {
  it('cycles through every proxy before repeating', () => {
    const pm = new ProxyManager(proxies, { rotationStrategy: 'round-robin' });
    const seen = [pm.getNextProxy()?.url, pm.getNextProxy()?.url, pm.getNextProxy()?.url];
    expect(new Set(seen).size).toBe(3);
    expect(pm.getNextProxy()?.url).toBe(seen[0]); // wraps back around
  });
});

describe('ProxyManager random', () => {
  it('only ever returns proxies from the configured pool', () => {
    const pm = new ProxyManager(proxies, { rotationStrategy: 'random' });
    const validUrls = new Set(proxies.map((p) => p.url));
    for (let i = 0; i < 20; i++) {
      expect(validUrls.has(pm.getNextProxy()!.url)).toBe(true);
    }
  });
});

describe('ProxyManager least-used', () => {
  it('prefers the proxy with the fewest recorded requests', () => {
    const pm = new ProxyManager(proxies, { rotationStrategy: 'least-used' });
    pm.reportSuccess('http://proxy1.test:8080', 100);
    pm.reportSuccess('http://proxy1.test:8080', 100);
    pm.reportSuccess('http://proxy2.test:8080', 100);

    // proxy3 has 0 uses — should be selected over proxy1 (2 uses) and proxy2 (1 use).
    expect(pm.getNextProxy()?.url).toBe('http://proxy3.test:8080');
  });
});

describe('ProxyManager fastest', () => {
  it('prefers the proxy with the lowest average response time', () => {
    const pm = new ProxyManager(proxies, { rotationStrategy: 'fastest' });
    pm.reportSuccess('http://proxy1.test:8080', 500);
    pm.reportSuccess('http://proxy2.test:8080', 50);
    pm.reportSuccess('http://proxy3.test:8080', 300);

    expect(pm.getNextProxy()?.url).toBe('http://proxy2.test:8080');
  });
});

describe('ProxyManager cooldown', () => {
  it('excludes a proxy from rotation after it hits the failure threshold', () => {
    const pm = new ProxyManager(proxies, {
      rotationStrategy: 'round-robin',
      failureThreshold: 2,
      cooldownMs: 10000,
    });

    pm.reportFailure('http://proxy1.test:8080', new Error('timeout'));
    pm.reportFailure('http://proxy1.test:8080', new Error('timeout'));

    const healthy = pm.getHealthyProxies().map((p) => p.url);
    expect(healthy).not.toContain('http://proxy1.test:8080');
    expect(healthy).toHaveLength(2);
  });

  it('resets consecutive failures on a success', () => {
    const pm = new ProxyManager(proxies, {
      rotationStrategy: 'round-robin',
      failureThreshold: 2,
      cooldownMs: 10000,
    });

    pm.reportFailure('http://proxy1.test:8080', new Error('timeout'));
    pm.reportSuccess('http://proxy1.test:8080', 100);
    pm.reportFailure('http://proxy1.test:8080', new Error('timeout'));

    // Only 1 consecutive failure since the success reset the streak — still healthy.
    const healthy = pm.getHealthyProxies().map((p) => p.url);
    expect(healthy).toContain('http://proxy1.test:8080');
  });

  it('becomes healthy again once the cooldown window has elapsed', async () => {
    const pm = new ProxyManager(proxies, {
      rotationStrategy: 'round-robin',
      failureThreshold: 1,
      cooldownMs: 30,
    });

    pm.reportFailure('http://proxy1.test:8080', new Error('timeout'));
    expect(pm.getHealthyProxies().map((p) => p.url)).not.toContain('http://proxy1.test:8080');

    await new Promise((r) => setTimeout(r, 50));

    expect(pm.getHealthyProxies().map((p) => p.url)).toContain('http://proxy1.test:8080');
  });

  it('returns null when every proxy is cooling down', () => {
    const pm = new ProxyManager(proxies, { failureThreshold: 1, cooldownMs: 10000 });
    for (const p of proxies) {
      pm.reportFailure(p.url, new Error('timeout'));
    }
    expect(pm.getNextProxy()).toBeNull();
  });
});

describe('ProxyManager pool management', () => {
  it('addProxy/removeProxy update the pool', () => {
    const pm = new ProxyManager([]);
    expect(pm.hasProxies()).toBe(false);

    pm.addProxy({ url: 'http://new.test:8080', type: 'http' });
    expect(pm.hasProxies()).toBe(true);
    expect(pm.getProxyCount()).toBe(1);

    expect(pm.removeProxy('http://new.test:8080')).toBe(true);
    expect(pm.hasProxies()).toBe(false);
  });

  it('getStats aggregates success/failure counts across the pool', () => {
    const pm = new ProxyManager(proxies);
    pm.reportSuccess('http://proxy1.test:8080', 100);
    pm.reportSuccess('http://proxy1.test:8080', 200);
    pm.reportFailure('http://proxy2.test:8080', new Error('x'));

    const stats = pm.getStats();
    expect(stats.totalSuccesses).toBe(2);
    expect(stats.totalFailures).toBe(1);
    expect(stats.totalRequests).toBe(3);
    expect(stats.averageResponseTime).toBeCloseTo(150, 0);
  });
});
