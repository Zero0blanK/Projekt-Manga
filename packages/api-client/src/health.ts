import { request, buildApiUrl } from './client.js';
import type {
  HealthStatus,
  ScraperHealth,
  ServerDiagnosticEvent,
  ServerRuntimeDiagnostics,
} from '@projekt-manga/types';
export type {
  HealthStatus,
  ScraperHealth,
  ServerDiagnosticEvent,
  ServerRuntimeDiagnostics,
} from '@projekt-manga/types';

/** Liveness check for GET /api/health — used by Settings > About to show whether the
 * app can currently reach its server. */
export const getHealth = (signal?: AbortSignal) => request<HealthStatus>('/health', { signal });

/** The API base URL in effect, for display. Derived from the same resolution `request()`
 * uses, so it can't disagree with where calls actually go. */
export const getApiBaseUrl = (): string => buildApiUrl('/').replace(/\/+$/, '');

/** Anti-detection and scraper statistics — proxy health, ban counts, cache hit rate.
 * Surfaced by the diagnostic report, which is what distinguishes "this user is being
 * blocked by a source" from "the app is broken". */
export const getScraperHealth = (signal?: AbortSignal) =>
  request<ScraperHealth>('/health/scraper', { signal });

export const getServerRuntimeDiagnostics = (signal?: AbortSignal) =>
  request<ServerRuntimeDiagnostics>('/health/runtime', { signal });

export const getRecentServerDiagnostics = (signal?: AbortSignal) =>
  request<ServerDiagnosticEvent[]>('/health/diagnostics', { signal });
