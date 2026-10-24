// Axios instance factories with anti-detection support: proxy agents, per-request
// User-Agent, ban detection, retry with backoff, and adaptive rate limiting.

import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosError,
  InternalAxiosRequestConfig,
  AxiosResponse,
} from 'axios';
import type { Agent } from 'node:http';
import { sourceConfigs, getSourceRateLimitMs } from './source.config.js';
import { ProxyConfig } from './anon.config.js';
import { getOrchestrator } from '../features/Orchestrator.js';
import type { AntiDetectionContext } from '../features/Orchestrator.js';
import { getLogger, DetectionEvent } from '../features/DetectionLogger.js';
import {
  clearCloudflareClearance,
  getCloudflareCookieHeader,
  updateCloudflareClearanceFromSetCookie,
} from '../features/CloudflareClearance.js';
import { getUserAgentManager } from '../features/UserAgentManager.js';

type AgentCtor = new (proxyUrl: string) => Agent;

const dynamicImport = <T>(specifier: string): Promise<T> =>
  new Function('s', 'return import(s)')(specifier) as Promise<T>;
const proxyAgentCache = new Map<string, Agent>();
type ExtendedAxiosRequestConfig = InternalAxiosRequestConfig & {
  _antiDetectionContext?: AntiDetectionContext;
  _proxyUrl?: string | null;
  _requestStartedAt?: number;
};

function resolveRequestUrl(
  requestConfig: Pick<AxiosRequestConfig, 'url' | 'baseURL'>,
  fallbackBaseUrl?: string,
): string | null {
  if (!requestConfig.url) {
    return null;
  }

  try {
    return new URL(requestConfig.url, requestConfig.baseURL || fallbackBaseUrl).toString();
  } catch {
    return null;
  }
}

function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function mergeCookieHeaders(existingHeader: string | null, injectedHeader: string): string {
  const merged = parseCookieHeader(existingHeader || '');
  const incoming = parseCookieHeader(injectedHeader);

  for (const [name, value] of incoming.entries()) {
    merged.set(name, value);
  }

  return Array.from(merged.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function readCookieHeader(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') {
    return null;
  }

  const h = headers as Record<string, unknown>;
  const raw = h['Cookie'] ?? h['cookie'];
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return null;
}

function writeCookieHeader(headers: unknown, cookieHeader: string): void {
  if (!headers || typeof headers !== 'object') {
    return;
  }

  const h = headers as Record<string, unknown>;
  h['Cookie'] = cookieHeader;
}

function syncCloudflareFromResponse(
  response: Pick<AxiosResponse, 'config' | 'headers'> | undefined,
  fallbackBaseUrl?: string,
): void {
  if (!response) {
    return;
  }

  const requestConfig = response.config as ExtendedAxiosRequestConfig;
  const targetUrl = resolveRequestUrl(requestConfig, fallbackBaseUrl);
  if (!targetUrl) {
    return;
  }

  updateCloudflareClearanceFromSetCookie(
    targetUrl,
    response.headers?.['set-cookie'],
    requestConfig._proxyUrl || null,
  );
}

export const defaultAxiosConfig: AxiosRequestConfig = {
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Projekt-Manga/1.0',
  },
  validateStatus: (status) => status >= 200 && status < 300,
};

async function createProxyAgent(proxy: ProxyConfig): Promise<Agent | null> {
  const cachedAgent = proxyAgentCache.get(proxy.url);
  if (cachedAgent) {
    return cachedAgent;
  }

  try {
    let agent: Agent;
    if (proxy.type === 'socks4' || proxy.type === 'socks5') {
      const { SocksProxyAgent } = await dynamicImport<{
        SocksProxyAgent: AgentCtor;
      }>('socks-proxy-agent');
      agent = new SocksProxyAgent(proxy.url);
    } else {
      const { HttpsProxyAgent } = await dynamicImport<{
        HttpsProxyAgent: AgentCtor;
      }>('https-proxy-agent');
      agent = new HttpsProxyAgent(proxy.url);
    }
    proxyAgentCache.set(proxy.url, agent);
    return agent;
  } catch (error) {
    getLogger().error('[Axios] Failed to create proxy agent', error as Error);
    return null;
  }
}

export interface AxiosAntiDetectionOptions {
  useProxy?: boolean;
  proxy?: ProxyConfig | null;
  useRandomUserAgent?: boolean;
  detectBans?: boolean;
}

export function createAxiosInstance(
  baseURL: string,
  config?: AxiosRequestConfig,
  antiDetection?: AxiosAntiDetectionOptions,
): AxiosInstance {
  const logger = getLogger();
  const finalConfig: AxiosRequestConfig = {
    baseURL,
    ...defaultAxiosConfig,
    ...config,
  };

  const instance = axios.create(finalConfig);

  instance.interceptors.request.use(
    async (requestConfig: ExtendedAxiosRequestConfig) => {
      // Resolved per request, not at instance creation, so UserAgentManager's rotation
      // and remote refresh take effect.
      if (antiDetection?.useRandomUserAgent !== false) {
        requestConfig.headers = requestConfig.headers || {};
        requestConfig.headers['User-Agent'] = getUserAgentManager().getCurrentProfile().userAgent;
      }

      if (antiDetection?.proxy) {
        const agent = await createProxyAgent(antiDetection.proxy);
        if (agent) {
          requestConfig.httpAgent = agent;
          requestConfig.httpsAgent = agent;
          requestConfig._proxyUrl = antiDetection.proxy.url;
        }
      }

      const targetUrl = resolveRequestUrl(requestConfig, baseURL);
      if (targetUrl) {
        const clearanceCookie = getCloudflareCookieHeader(
          targetUrl,
          requestConfig._proxyUrl || null,
        );
        if (clearanceCookie) {
          const existingCookieHeader = readCookieHeader(requestConfig.headers);
          const mergedCookieHeader = mergeCookieHeaders(existingCookieHeader, clearanceCookie);
          writeCookieHeader(requestConfig.headers, mergedCookieHeader);
        }
      }

      const method = requestConfig.method?.toUpperCase() || 'GET';
      const url = requestConfig.url || '';
      logger.debug(`[Axios] ${method} ${baseURL}${url}`);
      return requestConfig;
    },
    (error: AxiosError) => {
      logger.error('[Axios] Request error:', error);
      return Promise.reject(error);
    },
  );

  instance.interceptors.response.use(
    (response: AxiosResponse) => {
      logger.debug(`[Axios] Response ${response.status} from ${response.config.url}`);
      syncCloudflareFromResponse(response, baseURL);

      // Soft bans: challenge pages served with a 2xx status.
      if (antiDetection?.detectBans) {
        const orchestrator = getOrchestrator();
        const data = typeof response.data === 'string' ? response.data : '';

        if (orchestrator.isBanResponse(data, response.status)) {
          logger.log(DetectionEvent.BAN_DETECTED, {
            source: 'Axios',
            url: response.config.url,
            details: { statusCode: response.status, type: 'soft_ban' },
          });
        }

        if (orchestrator.isCloudflareChallenge(data)) {
          logger.log(DetectionEvent.CLOUDFLARE_CHALLENGE, {
            source: 'Axios',
            url: response.config.url,
            details: { solved: false },
          });
        }
      }

      return response;
    },
    (error: AxiosError) => {
      if (error.response) {
        syncCloudflareFromResponse(error.response, baseURL);
        const requestConfig = error.config as ExtendedAxiosRequestConfig | undefined;
        const targetUrl = requestConfig ? resolveRequestUrl(requestConfig, baseURL) : null;

        if (error.response.status === 429) {
          logger.log(DetectionEvent.RATE_LIMIT_HIT, {
            source: 'Axios',
            url: error.config?.url,
            details: {
              retryAfter: error.response.headers['retry-after'],
            },
          });
        }

        if (error.response.status === 403 || error.response.status === 503) {
          if (targetUrl) {
            clearCloudflareClearance(targetUrl, requestConfig?._proxyUrl || null);
          }
          logger.log(DetectionEvent.BAN_DETECTED, {
            source: 'Axios',
            url: error.config?.url,
            details: { statusCode: error.response.status },
          });
        }

        logger.error(`[Axios] Error ${error.response.status}: ${error.config?.url}`, error);
      } else if (error.request) {
        logger.error(`[Axios] No response from ${error.config?.url}`, error);
      } else {
        logger.error(`[Axios] Request setup error:`, error);
      }
      return Promise.reject(error);
    },
  );

  return instance;
}

export interface RetryConfig {
  maxRetries?: number;
  retryDelay?: number;
  retryCondition?: (error: AxiosError) => boolean;
}

export interface RateLimitConfig {
  minInterval?: number;
  adaptiveStepMs?: number;
  recoveryStepMs?: number;
  maxAdaptiveDelayMs?: number;
  /** Random extra delay (0..jitterMs) added to each request's interval to avoid a
   *  perfectly periodic request cadence. Defaults to 30% of minInterval. */
  jitterMs?: number;
}

export function addRetryInterceptor(
  instance: AxiosInstance,
  config: RetryConfig = {},
): AxiosInstance {
  const logger = getLogger();
  const {
    maxRetries = 3,
    retryDelay = 1000,
    retryCondition = (error: AxiosError) => {
      return !error.response || (error.response.status >= 500 && error.response.status < 600);
    },
  } = config;

  instance.interceptors.response.use(undefined, async (error: AxiosError) => {
    const requestConfig = error.config as InternalAxiosRequestConfig & {
      _retryCount?: number;
    };

    if (!requestConfig || !retryCondition(error)) {
      return Promise.reject(error);
    }

    requestConfig._retryCount = requestConfig._retryCount || 0;

    if (requestConfig._retryCount >= maxRetries) {
      logger.error(`[Axios] Max retries (${maxRetries}) reached for ${requestConfig.url}`, error);
      return Promise.reject(error);
    }

    requestConfig._retryCount += 1;
    // Jittered exponential backoff so concurrent retries don't hit the origin in lockstep.
    const backoff = retryDelay * Math.pow(2, requestConfig._retryCount - 1);
    const delay = Math.round(backoff / 2 + Math.random() * (backoff / 2));

    logger.warn(
      `[Axios] Retry ${requestConfig._retryCount}/${maxRetries} for ${requestConfig.url} after ${delay}ms`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    return instance(requestConfig);
  });

  return instance;
}

export function addRateLimitInterceptor(
  instance: AxiosInstance,
  config: number | RateLimitConfig = 200,
): AxiosInstance {
  const rateLimitConfig: RateLimitConfig =
    typeof config === 'number' ? { minInterval: config } : config;

  const minInterval = rateLimitConfig.minInterval ?? 200;
  const adaptiveStepMs = rateLimitConfig.adaptiveStepMs ?? 250;
  const recoveryStepMs = rateLimitConfig.recoveryStepMs ?? 25;
  const maxAdaptiveDelayMs = rateLimitConfig.maxAdaptiveDelayMs ?? 5000;
  const jitterMs = rateLimitConfig.jitterMs ?? Math.round(minInterval * 0.3);

  let lastRequestTime = 0;
  let adaptiveDelayMs = 0;
  const queue: Array<() => void> = [];
  let processing = false;

  const processQueue = async () => {
    if (processing || queue.length === 0) {
      return;
    }

    processing = true;

    while (queue.length > 0) {
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;
      const intervalWithPenalty = minInterval + adaptiveDelayMs + jitter;

      if (timeSinceLastRequest < intervalWithPenalty) {
        await new Promise((resolve) =>
          setTimeout(resolve, intervalWithPenalty - timeSinceLastRequest),
        );
      }

      lastRequestTime = Date.now();
      const next = queue.shift();
      if (next) {
        next();
      }
    }

    processing = false;
  };

  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    return new Promise((resolve) => {
      queue.push(() => resolve(config));
      processQueue();
    });
  });

  instance.interceptors.response.use(
    (response) => {
      adaptiveDelayMs = Math.max(0, adaptiveDelayMs - recoveryStepMs);
      return response;
    },
    (error: AxiosError) => {
      const statusCode = error.response?.status;
      const retryAfterHeader = error.response?.headers?.['retry-after'];
      const retryAfterSec = Number.parseInt(String(retryAfterHeader || ''), 10);
      const retryAfterMs = Number.isFinite(retryAfterSec) ? Math.max(0, retryAfterSec * 1000) : 0;

      if (statusCode === 429 || statusCode === 403 || statusCode === 503) {
        const increasedDelay = Math.max(retryAfterMs, adaptiveDelayMs + adaptiveStepMs);
        adaptiveDelayMs = Math.min(maxAdaptiveDelayMs, increasedDelay);
      } else if (adaptiveDelayMs > 0) {
        adaptiveDelayMs = Math.max(0, adaptiveDelayMs - recoveryStepMs);
      }

      return Promise.reject(error);
    },
  );

  return instance;
}

export function addAntiDetectionInterceptor(instance: AxiosInstance): AxiosInstance {
  const orchestrator = getOrchestrator();

  instance.interceptors.request.use(async (config: ExtendedAxiosRequestConfig) => {
    if (!orchestrator.isEnabled()) {
      return config;
    }

    const context = await orchestrator.getContext();

    if (context.proxy) {
      const agent = await createProxyAgent(context.proxy);
      if (agent) {
        config.httpAgent = agent;
        config.httpsAgent = agent;
      }
    }

    config.headers = config.headers || {};
    config.headers['User-Agent'] = context.fingerprint.userAgent;
    config._antiDetectionContext = context;
    config._proxyUrl = context.proxy?.url || null;
    config._requestStartedAt = Date.now();

    return config;
  });

  // Detects bans and reports success/failure so proxy health (failure streaks, response
  // times) stays accurate.
  instance.interceptors.response.use(
    async (response: AxiosResponse) => {
      if (!orchestrator.isEnabled()) {
        return response;
      }

      const data = typeof response.data === 'string' ? response.data : '';
      const requestConfig = response.config as ExtendedAxiosRequestConfig;
      const requestContext = requestConfig._antiDetectionContext;
      const responseTimeMs = requestConfig._requestStartedAt
        ? Date.now() - requestConfig._requestStartedAt
        : 0;

      if (requestContext) {
        if (orchestrator.isBanResponse(data, response.status)) {
          orchestrator.reportBan(requestContext, 'axios_soft_ban');
        } else {
          orchestrator.reportSuccess(requestContext, responseTimeMs);
        }
      }

      return response;
    },
    async (error: AxiosError) => {
      if (!orchestrator.isEnabled()) {
        return Promise.reject(error);
      }

      const requestContext = (error.config as ExtendedAxiosRequestConfig | undefined)
        ?._antiDetectionContext;

      if (requestContext) {
        if (error.response?.status === 403 || error.response?.status === 429) {
          orchestrator.reportBan(
            requestContext,
            error.response.status === 429 ? 'rate_limit' : 'forbidden',
          );
        } else {
          orchestrator.reportFailure(requestContext, error);
        }
      }

      return Promise.reject(error);
    },
  );

  return instance;
}

export function createSourceAxios(
  sourceName: keyof typeof sourceConfigs,
  options: {
    enableRetry?: boolean;
    retryConfig?: RetryConfig;
    rateLimitMs?: number;
    enableAntiDetection?: boolean;
    antiDetection?: AxiosAntiDetectionOptions;
  } = {},
): AxiosInstance {
  const config = sourceConfigs[sourceName];
  let instance = createAxiosInstance(config.baseURL, config, options.antiDetection);

  if (options.enableRetry) {
    instance = addRetryInterceptor(instance, options.retryConfig);
  }

  const sourceRateLimitMs = options.rateLimitMs ?? getSourceRateLimitMs(sourceName);
  if (sourceRateLimitMs > 0) {
    instance = addRateLimitInterceptor(instance, { minInterval: sourceRateLimitMs });
  }

  if (options.enableAntiDetection) {
    instance = addAntiDetectionInterceptor(instance);
  }

  return instance;
}

export async function createAntiDetectionAxios(
  baseURL: string,
  config?: AxiosRequestConfig,
): Promise<AxiosInstance> {
  const orchestrator = getOrchestrator();

  if (!orchestrator.isEnabled()) {
    return createAxiosInstance(baseURL, config);
  }

  const context = await orchestrator.getContext();

  let instance = createAxiosInstance(baseURL, config, {
    proxy: context.proxy,
    useRandomUserAgent: false,
    detectBans: true,
  });

  instance.defaults.headers['User-Agent'] = context.fingerprint.userAgent;

  instance = addAntiDetectionInterceptor(instance);

  return instance;
}
