import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { guardedFetch } from '../../../utils/guardedFetch.js';
import {
  PINNED_SERVER,
  SERVER_REPOSITORY,
  runtimeAssetsUrl,
  type RuntimePlatform,
  type ServerRelease,
} from './manifest.js';

/**
 * Downloads for the extension engine, only ever from where its parts are published.
 *
 * Every request, and every redirect it follows, must go over HTTPS to one of the hosts
 * below, through the same public-address guard as other outbound requests. A file is
 * streamed to disk while its SHA-256 is computed, and is only kept when that matches the
 * checksum its publisher lists for it.
 */

/** GitHub (Suwayomi-Server's releases and Temurin's binaries) and Adoptium's API. */
const DEFAULT_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'api.adoptium.net',
]);

/** Larger than any part has ever been; a response beyond it is not what was asked for. */
const MAX_DOWNLOAD_BYTES = 800 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const METADATA_TIMEOUT_MS = 30_000;

type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = guardedFetch;
let allowedHosts = DEFAULT_HOSTS;
let allowHttp = false;

/** Test seam: a local mirror instead of the real hosts. */
export function setEngineDownloadsForTests(
  options: { fetch: FetchLike; hosts: string[]; allowHttp?: boolean } | null,
): void {
  fetchImpl = options?.fetch ?? guardedFetch;
  allowedHosts = options ? new Set(options.hosts) : DEFAULT_HOSTS;
  allowHttp = options?.allowHttp ?? false;
}

export class EngineDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineDownloadError';
  }
}

function checkUrl(url: URL): void {
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new EngineDownloadError('Engine downloads must use HTTPS');
  }
  if (!allowedHosts.has(url.hostname)) {
    throw new EngineDownloadError(`Engine downloads are not allowed from ${url.hostname}`);
  }
}

/** Fetches with redirects followed by hand, so each hop's host is checked. */
async function fetchChecked(url: URL, init: RequestInit): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrl(current);
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new EngineDownloadError('A download redirect had no destination');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new EngineDownloadError(`The download server answered ${response.status}`);
    }
    return response;
  }
  throw new EngineDownloadError('Too many redirects');
}

async function fetchJson<T>(url: URL, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(METADATA_TIMEOUT_MS);
  const response = await fetchChecked(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'ProjektManga' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  return (await response.json()) as T;
}

export interface DownloadProgress {
  received: number;
  total: number | null;
}

/**
 * Streams `url` into `destination`, checking its SHA-256 against `sha256` (hex). On a
 * mismatch, an error or a cancel, the partial file is deleted and nothing is left behind.
 */
export async function downloadVerified(
  url: URL,
  destination: string,
  sha256: string,
  options: { size?: number; signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void },
): Promise<void> {
  const expected = sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new EngineDownloadError('No valid checksum');
  const hash = createHash('sha256');
  let received = 0;
  try {
    const response = await fetchChecked(url, {
      headers: { 'User-Agent': 'ProjektManga' },
      signal: options.signal,
    });
    const header = Number(response.headers.get('content-length'));
    const total = options.size ?? (Number.isFinite(header) && header > 0 ? header : null);
    if (!response.body) throw new EngineDownloadError('The download was empty');
    const out = fs.createWriteStream(destination, { mode: 0o600 });
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new EngineDownloadError('The download is larger than expected');
        }
        hash.update(value);
        if (!out.write(value))
          await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        options.onProgress?.({ received, total });
      }
    } finally {
      out.end();
      await done.catch(() => undefined);
    }
    if (options.size !== undefined && received !== options.size) {
      throw new EngineDownloadError('The download is not the expected size');
    }
    if (hash.digest('hex') !== expected) {
      throw new EngineDownloadError("The download doesn't match its published checksum");
    }
  } catch (error) {
    await fsp.rm(destination, { force: true });
    if (options.signal?.aborted) throw new EngineDownloadError('Cancelled');
    throw error;
  }
}

/** The latest Suwayomi-Server release, with the digest GitHub publishes for its jar. */
export async function latestServerRelease(signal?: AbortSignal): Promise<ServerRelease> {
  const release = await fetchJson<{
    tag_name?: string;
    assets?: Array<{ name?: string; size?: number; digest?: string }>;
  }>(new URL(`https://api.github.com/repos/${SERVER_REPOSITORY}/releases/latest`), signal);
  const version = release.tag_name ?? '';
  const asset = release.assets?.find((item) => item.name === `Suwayomi-Server-${version}.jar`);
  const digest = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
  if (!version || !asset?.name || !digest || !asset.size) {
    throw new EngineDownloadError('The latest engine release has no verifiable jar');
  }
  return { version, asset: asset.name, sha256: digest.toLowerCase(), size: asset.size };
}

/** Where a server release's jar is downloaded from. */
export function serverJarUrl(release: ServerRelease = PINNED_SERVER): URL {
  return new URL(
    `https://github.com/${SERVER_REPOSITORY}/releases/download/${encodeURIComponent(release.version)}/${encodeURIComponent(release.asset)}`,
  );
}

export interface RuntimeRelease {
  /** e.g. "jdk-21.0.13.1+2". Also the folder name it is installed under. */
  version: string;
  url: URL;
  sha256: string;
  size: number;
  /** "zip" on Windows, "tar.gz" elsewhere. */
  archive: 'zip' | 'tar.gz';
}

/** The latest Temurin JRE for this platform, with Adoptium's checksum. */
export async function latestRuntime(
  platform: RuntimePlatform,
  signal?: AbortSignal,
): Promise<RuntimeRelease> {
  const assets = await fetchJson<
    Array<{
      release_name?: string;
      binary?: { package?: { link?: string; checksum?: string; size?: number; name?: string } };
    }>
  >(runtimeAssetsUrl(platform), signal);
  const first = assets[0];
  const pkg = first?.binary?.package;
  const name = pkg?.name ?? '';
  const archive = name.endsWith('.zip') ? 'zip' : name.endsWith('.tar.gz') ? 'tar.gz' : null;
  if (!first?.release_name || !pkg?.link || !pkg.checksum || !pkg.size || !archive) {
    throw new EngineDownloadError('No Java runtime is published for this platform');
  }
  return {
    version: first.release_name,
    url: new URL(pkg.link),
    sha256: pkg.checksum.toLowerCase(),
    size: pkg.size,
    archive,
  };
}
