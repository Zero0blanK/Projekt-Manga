/**
 * Source configuration module for Projekt Manga extension.
 * Provides functions to create source configurations with built-in anti-detection features,
 * including dynamic base URL management and request header customization.
 *
 * There are no bundled sources: every source is installed at runtime from a repository
 * (see `sandboxedSourceRegistry.service.ts`) and runs sandboxed, with its rate limit
 * declared in its manifest. The per-source registry here covers only the two placeholder
 * entries below; the generic knobs (`getBrowserFallbackTimeoutMs`, circuit breaker
 * thresholds) are source-independent and used by the anti-detection stack.
 */
import { createReqConfig } from './req.config.js';

const DEFAULT_TIMEOUT_MS = 20000;

type SourceFetchMode = 'api-first' | 'html-first' | 'cloudflare-first';

interface SourceDefaults {
  id: string;
  baseUrl: string;
  rateLimitMs: number;
  cacheTtlMs: number;
  fetchMode: SourceFetchMode;
}

// Config-only placeholders: no bundled-source implementation or loader uses them.
const SOURCE_DEFAULTS = {
  asuraScans: {
    id: 'asuraScans',
    baseUrl: 'https://asuracomic.net',
    rateLimitMs: 220,
    cacheTtlMs: 2 * 60 * 1000,
    fetchMode: 'html-first',
  },
  mangakakalot: {
    id: 'mangakakalot',
    baseUrl: 'https://mangakakalot.com',
    rateLimitMs: 240,
    cacheTtlMs: 2 * 60 * 1000,
    fetchMode: 'html-first',
  },
} as const satisfies Record<string, SourceDefaults>;

type SourceName = keyof typeof SOURCE_DEFAULTS;

/** Every source name this config layer knows about (all placeholders). */
export function getKnownSourceNames(): string[] {
  return Object.keys(SOURCE_DEFAULTS);
}

function getSourceBaseUrl(source: SourceName): string {
  const envKey = `EXT_SOURCE_${source.toUpperCase()}_BASE_URL`;
  const envValue = process.env[envKey];
  return envValue?.trim() || SOURCE_DEFAULTS[source].baseUrl;
}

export function getSourceRateLimitMs(source: SourceName): number {
  const envKey = `EXT_SOURCE_${source.toUpperCase()}_RATE_LIMIT_MS`;
  const envValue = process.env[envKey];
  const parsed = envValue ? Number.parseInt(envValue.trim(), 10) : Number.NaN;

  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  return SOURCE_DEFAULTS[source].rateLimitMs;
}

export function getSourceCacheTtlMs(source: SourceName): number {
  const envKey = `EXT_SOURCE_${source.toUpperCase()}_CACHE_TTL_MS`;
  const envValue = process.env[envKey];
  const parsed = envValue ? Number.parseInt(envValue.trim(), 10) : Number.NaN;

  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  return SOURCE_DEFAULTS[source].cacheTtlMs;
}

export function getSourceFetchMode(source: string): SourceFetchMode {
  if (source in SOURCE_DEFAULTS) {
    return SOURCE_DEFAULTS[source as SourceName].fetchMode;
  }
  return 'html-first';
}

/** Timeout for a single Playwright/Puppeteer fallback fetch attempt. */
export function getBrowserFallbackTimeoutMs(): number {
  const envValue = process.env.EXT_BROWSER_FALLBACK_TIMEOUT_MS;
  const parsed = envValue ? Number.parseInt(envValue.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30000;
}

/** Consecutive failures before a source's circuit breaker opens. */
export function getBreakerFailureThreshold(): number {
  const envValue = process.env.EXT_BREAKER_FAILURE_THRESHOLD;
  const parsed = envValue ? Number.parseInt(envValue.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
}

/** How long a source's circuit breaker stays open once it trips. */
export function getBreakerCooldownMs(): number {
  const envValue = process.env.EXT_BREAKER_COOLDOWN_MS;
  const parsed = envValue ? Number.parseInt(envValue.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2 * 60 * 1000;
}

export function createSourceConfigs(timeout = DEFAULT_TIMEOUT_MS) {
  return {
    asuraScans: {
      baseURL: getSourceBaseUrl('asuraScans'),
      timeout,
      ...createReqConfig(),
    },

    mangakakalot: {
      baseURL: getSourceBaseUrl('mangakakalot'),
      timeout,
      ...createReqConfig(),
    },
  } as const;
}

export const sourceConfigs = createSourceConfigs();
