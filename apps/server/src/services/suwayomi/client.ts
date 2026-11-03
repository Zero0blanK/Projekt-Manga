import axios from 'axios';
import type { SourceErrorCode } from '@projekt-manga/types';
import { detectRasterImageType, MAX_IMAGE_BYTES } from '../../utils/imageContent.js';
import { readSuwayomiConnection, type SuwayomiConnection } from './settings.js';

/**
 * Requests to the host's Suwayomi server.
 *
 * Suwayomi normally runs on this machine or the LAN, which the public-address guard every
 * other outbound request goes through refuses. Instead of relaxing that guard, this client
 * can only reach the one origin the admin saved: every URL is built from (or checked
 * against) the saved base URL, and redirects are never followed, so the login can't be
 * handed to another host. Errors carry neither the URL nor the login.
 */

const GRAPHQL_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 30_000;
const MAX_GRAPHQL_BYTES = 20 * 1024 * 1024;

/** Thrown with a source error code, so source.service reports it like an extension's. */
export class SuwayomiError extends Error {
  readonly code: SourceErrorCode;
  constructor(code: SourceErrorCode, message: string) {
    super(message);
    this.name = 'SuwayomiError';
    this.code = code;
  }
}

export function requireConnection(): SuwayomiConnection {
  const connection = readSuwayomiConnection();
  if (!connection) {
    throw new SuwayomiError('NETWORK_ERROR', 'The Suwayomi server is not connected');
  }
  return connection;
}

function headers(connection: SuwayomiConnection, accept: string): Record<string, string> {
  return {
    Accept: accept,
    ...(connection.authorization ? { Authorization: connection.authorization } : {}),
  };
}

function toSuwayomiError(error: unknown): SuwayomiError {
  if (error instanceof SuwayomiError) return error;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return new SuwayomiError('BLOCKED', 'The Suwayomi server refused the saved login');
    }
    if (status === 404) return new SuwayomiError('NOT_FOUND', 'Suwayomi has no such item');
    if (status === 429) return new SuwayomiError('RATE_LIMITED', 'Suwayomi is rate-limiting');
    if (status && status >= 300 && status < 400) {
      return new SuwayomiError('UPSTREAM_ERROR', 'The Suwayomi server answered with a redirect');
    }
    if (status) {
      return new SuwayomiError('UPSTREAM_ERROR', `The Suwayomi server answered ${status}`);
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new SuwayomiError('TIMEOUT', 'The Suwayomi server did not answer in time');
    }
    if (
      error.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED' ||
      /maxContentLength/.test(error.message)
    ) {
      return new SuwayomiError('UPSTREAM_ERROR', 'The Suwayomi response is too large');
    }
    return new SuwayomiError('NETWORK_ERROR', 'The Suwayomi server is not reachable');
  }
  return new SuwayomiError('UPSTREAM_ERROR', 'The Suwayomi request failed');
}

/** Turns a GraphQL error into a code. A source's own failure (site down, Cloudflare)
 * arrives as the message of an exception Suwayomi caught, so only its gist is kept: no
 * Java stack trace, no URLs. */
function graphqlError(message: string): SuwayomiError {
  // Suwayomi passes Cloudflare only through FlareSolverr, which is off by default.
  if (/cloudflare bypass currently disabled/i.test(message)) {
    return new SuwayomiError(
      'BLOCKED',
      "This site wants a Cloudflare check, and Suwayomi's Cloudflare bypass is off. Turn on FlareSolverr in Suwayomi's settings (it needs a FlareSolverr server running) and try again.",
    );
  }
  const gist = message
    .split(/\s+at\s+[\w$.]+\(/)[0]
    .replace(/^Exception while fetching data \([^)]*\)\s*:\s*/i, '')
    .replace(/(?:java|kotlin)(?:\.\w+)+(?:Exception|Error):\s*/g, '');
  const text = gist
    .replace(/https?:\/\/\S+/g, '[url]')
    .trim()
    .slice(0, 300);
  if (/cloudflare|challenge/i.test(text)) {
    return new SuwayomiError('BLOCKED', `Suwayomi: ${text}`);
  }
  if (/timed? ?out/i.test(text)) return new SuwayomiError('TIMEOUT', `Suwayomi: ${text}`);
  if (/\b404\b|not found/i.test(text)) return new SuwayomiError('NOT_FOUND', `Suwayomi: ${text}`);
  if (/\b429\b/.test(text)) return new SuwayomiError('RATE_LIMITED', `Suwayomi: ${text}`);
  return new SuwayomiError('UPSTREAM_ERROR', `Suwayomi: ${text}`);
}

export async function suwayomiGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  connection: SuwayomiConnection = requireConnection(),
): Promise<T> {
  let body: { data?: T; errors?: Array<{ message?: unknown }> };
  try {
    const response = await axios.post(
      `${connection.baseUrl}/api/graphql`,
      { query, variables },
      {
        headers: { ...headers(connection, 'application/json'), 'Content-Type': 'application/json' },
        timeout: GRAPHQL_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: MAX_GRAPHQL_BYTES,
        responseType: 'json',
      },
    );
    body = response.data as typeof body;
  } catch (error) {
    // A GraphQL error can come back with a 4xx status and the reason in the body.
    if (axios.isAxiosError(error) && error.response) {
      const { status, data } = error.response;
      const message = (data as { errors?: Array<{ message?: unknown }> } | undefined)?.errors?.[0]
        ?.message;
      if (status !== 401 && status !== 403 && typeof message === 'string') {
        throw graphqlError(message);
      }
    }
    throw toSuwayomiError(error);
  }
  if (!body || typeof body !== 'object') {
    throw new SuwayomiError('PARSE_ERROR', 'The Suwayomi server did not answer with GraphQL');
  }
  const message = body.errors?.[0]?.message;
  if (body.errors?.length) {
    throw graphqlError(typeof message === 'string' ? message : 'unknown error');
  }
  if (!body.data) throw new SuwayomiError('PARSE_ERROR', 'The Suwayomi answer had no data');
  return body.data;
}

/** Makes a server-relative path from Suwayomi (`/api/v1/...`) absolute on its origin. */
export function absoluteSuwayomiUrl(
  value: string | null | undefined,
  connection: SuwayomiConnection,
): string {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    return isSuwayomiImageUrl(value, connection) ? value : '';
  }
  return `${connection.baseUrl}${value.startsWith('/') ? '' : '/'}${value}`;
}

/** True only for an image path on the saved Suwayomi origin — the one place the image proxy
 * and downloads may reach without the public-address guard. */
export function isSuwayomiImageUrl(
  value: string,
  connection: SuwayomiConnection | null = readSuwayomiConnection(),
): boolean {
  if (!connection) return false;
  let url: URL;
  let base: URL;
  try {
    url = new URL(value);
    base = new URL(connection.baseUrl);
  } catch {
    return false;
  }
  if (url.username || url.password || url.origin !== base.origin) return false;
  const prefix = `${base.pathname.replace(/\/+$/, '')}/api/v1/`;
  return url.pathname.startsWith(prefix) && !url.pathname.includes('/../');
}

export interface SuwayomiImage {
  bytes: Buffer;
  contentType: string;
}

/** Fetches one image from the Suwayomi server, checked to be a raster image within the
 * size cap. */
export async function fetchSuwayomiImage(
  url: string,
  signal?: AbortSignal,
): Promise<SuwayomiImage> {
  const connection = requireConnection();
  if (!isSuwayomiImageUrl(url, connection)) {
    throw new SuwayomiError('BLOCKED', 'Not an image on the Suwayomi server');
  }
  let bytes: Buffer;
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      headers: headers(connection, 'image/*'),
      responseType: 'arraybuffer',
      timeout: IMAGE_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: MAX_IMAGE_BYTES,
      signal,
    });
    bytes = Buffer.from(response.data);
  } catch (error) {
    throw toSuwayomiError(error);
  }
  const contentType = detectRasterImageType(bytes.subarray(0, 32));
  if (!contentType) throw new SuwayomiError('UPSTREAM_ERROR', 'Suwayomi did not return an image');
  return { bytes, contentType };
}
