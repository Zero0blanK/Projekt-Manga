import axios, { type AxiosRequestConfig } from 'axios';
import {
  assertPublicHttpUrl,
  guardedHttpAgent,
  guardedHttpsAgent,
  UnsafeUrlError,
} from '../../utils/ssrfGuard.js';
import { UnauthorizedError, ValidationError } from '../../utils/customErrors.js';
import { requestWithRetry, toCredentialError, toTrackerError } from './httpRetry.js';

/**
 * Shared plumbing for the self-hosted "trackers" (Komga, Kavita): the reader supplies a
 * server base URL plus an API key, so every request goes to a host chosen by the client.
 *
 * - The URL is checked with the same public-address guard the extensions and image proxy
 *   use, and requests go through the guarded agents so DNS rebinding can't swap in a
 *   private address afterwards. Redirects are refused outright: following one would hand
 *   the API key to whatever host it points at.
 * - Many people run Komga/Kavita on their own LAN, which that guard blocks. An operator
 *   who trusts every account on their server can set TRACKER_ALLOW_PRIVATE_URLS=true to
 *   allow private/loopback addresses for these two trackers only (nothing else relaxes).
 *
 * The base URL and key are stored together as the account's encrypted `access_token`
 * (serialized JSON), so no schema change is needed and the key gets the same encryption
 * at rest as every OAuth token.
 */

export interface ServerCredential {
  base_url: string;
  api_key: string;
}

export function privateUrlsAllowed(): boolean {
  return process.env.TRACKER_ALLOW_PRIVATE_URLS === 'true';
}

/** Parses and validates a reader-supplied server URL, returning it without a trailing
 * slash. Throws a ValidationError with a message safe to show the reader. */
export async function normalizeServerUrl(raw: string, label: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ValidationError(
      `Enter your ${label} server's full URL, e.g. https://${label.toLowerCase()}.example.com`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${label} URL must start with http:// or https://`);
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError(`${label} URL must not contain a username or password`);
  }
  if (!privateUrlsAllowed()) {
    try {
      await assertPublicHttpUrl(parsed.toString());
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new ValidationError(
          `${label} URL must be publicly reachable — private and local network addresses are blocked on this server.`,
        );
      }
      throw error;
    }
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

export function encodeServerCredential(credential: ServerCredential): string {
  return JSON.stringify(credential);
}

export function decodeServerCredential(accessToken: string, label: string): ServerCredential {
  try {
    const parsed = JSON.parse(accessToken) as Partial<ServerCredential>;
    if (typeof parsed.base_url === 'string' && typeof parsed.api_key === 'string') {
      return { base_url: parsed.base_url, api_key: parsed.api_key };
    }
  } catch {
    // fall through
  }
  throw new UnauthorizedError(`Your ${label} connection is invalid — reconnect it in Settings.`);
}

export interface ServerRequest {
  method: 'get' | 'post' | 'put';
  path: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number>;
  data?: unknown;
}

/**
 * One request to a reader's server. `credentials: true` marks the sign-in/key check so a
 * rejected key reads as "wrong credentials" rather than a generic failure. Neither the URL
 * (which may carry the key as a query parameter) nor the upstream error text is ever put
 * in the thrown error.
 */
export async function serverRequest<T>(
  baseUrl: string,
  request: ServerRequest,
  label: string,
  { credentials = false }: { credentials?: boolean } = {},
): Promise<T> {
  const config: AxiosRequestConfig = {
    method: request.method,
    url: `${baseUrl}${request.path}`,
    params: request.params,
    data: request.data,
    headers: { Accept: 'application/json', ...request.headers },
    timeout: 15000,
    maxRedirects: 0,
    ...(privateUrlsAllowed()
      ? {}
      : { proxy: false as const, httpAgent: guardedHttpAgent, httpsAgent: guardedHttpsAgent }),
  };
  try {
    const response = await requestWithRetry(() => axios.request<T>(config));
    return response.data;
  } catch (error) {
    if (credentials) toCredentialError(error, label);
    toTrackerError(error, label);
  }
}
