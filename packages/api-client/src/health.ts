import { request, buildApiUrl } from './client.js';

export interface HealthStatus {
  status: string;
  timestamp: string;
  endpoints: string[];
}

/** Liveness check for GET /api/health — used by Settings > About to show whether the
 * app can currently reach its server. */
export const getHealth = (signal?: AbortSignal) => request<HealthStatus>('/health', { signal });

/** The API base URL in effect, for display. Derived from the same resolution `request()`
 * uses, so it can't disagree with where calls actually go. */
export const getApiBaseUrl = (): string => buildApiUrl('/').replace(/\/+$/, '');

/**
 * Shape of GET /api/health/scraper. Only the fields a caller actually reads are declared —
 * the endpoint returns more (per-proxy detail, circuit-breaker internals, the full recent
 * ban list), and pulling all of it into a shared type would invite it into places that
 * shouldn't show it. `recentBans` entries are intentionally left opaque: the diagnostic
 * report counts them rather than printing per-title URLs.
 */
export interface ScraperHealth {
  available?: boolean;
  reason?: string;
  enabled: boolean;
  proxy: {
    totalProxies: number;
    healthyProxies: number;
    coolingDownProxies: number;
  };
  htmlCache: {
    hits: number;
    misses: number;
  };
  recentBans: unknown[];
  userAgent: {
    usingRemoteProfile: boolean;
    profileCount: number;
  };
  circuitBreakers?: Array<{
    source: string;
    consecutiveFailures: number;
    isOpen: boolean;
    openRemainingMs: number;
  }>;
}

export interface ServerDiagnosticEvent {
  at: string;
  level: 'info' | 'warn' | 'error';
  area: 'api' | 'download' | 'restore' | 'sync';
  event: string;
  requestId: string | null;
  jobId: string | null;
  code: string | null;
  counts: Record<string, number>;
}

/** Anti-detection and scraper statistics — proxy health, ban counts, cache hit rate.
 * Surfaced by the diagnostic report, which is what distinguishes "this user is being
 * blocked by a source" from "the app is broken". */
export const getScraperHealth = (signal?: AbortSignal) =>
  request<ScraperHealth>('/health/scraper', { signal });

export const getRecentServerDiagnostics = (signal?: AbortSignal) =>
  request<ServerDiagnosticEvent[]>('/health/diagnostics', { signal });
