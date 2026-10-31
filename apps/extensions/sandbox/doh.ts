/**
 * DNS over HTTPS for the sandbox parent's brokered fetch.
 *
 * Only *how* a hostname is resolved changes here. The caller still checks the source's
 * host allowlist on the hostname and runs the public-address validation on every address
 * this returns, then pins the connection to one of them, so a resolver that answers with a
 * private address gets the request refused exactly as system DNS would.
 *
 * Uses the JSON API (`application/dns-json`) that Cloudflare, Google and most public
 * resolvers serve. The resolver URL is never put in an error message: some resolvers carry
 * an account id in the path or query.
 */
import net from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

const DOH_TIMEOUT_MS = 5000;
/** A DNS JSON answer is a few hundred bytes; anything near this is not one. */
const MAX_DOH_RESPONSE_BYTES = 64 * 1024;
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;

const RECORD_TYPES = [
  { type: 1, name: 'A', family: 4 },
  { type: 28, name: 'AAAA', family: 6 },
] as const;

const cache = new Map<string, { addresses: ResolvedAddress[]; expiresAt: number }>();

/** Test seam: cached answers outlive a single test otherwise. */
export function clearDohCacheForTests(): void {
  cache.clear();
}

/** Whether a resolver URL is usable at all: https, no credentials. */
export function isUsableDohUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function queryType(
  hostname: string,
  endpoint: URL,
  record: (typeof RECORD_TYPES)[number],
  fetchImpl: FetchLike,
  readBody: (response: Response) => Promise<Buffer>,
  signal: AbortSignal,
): Promise<{ addresses: ResolvedAddress[]; ttlMs: number }> {
  const url = new URL(endpoint);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', record.name);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    // A resolver that redirects is not followed: the redirect target was never checked.
    redirect: 'manual',
    signal,
  });
  if (!response.ok) throw new Error(`resolver answered HTTP ${response.status}`);
  const parsed: unknown = JSON.parse((await readBody(response)).toString('utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('resolver sent no JSON object');
  const { Status, Answer } = parsed as { Status?: unknown; Answer?: unknown };
  // 3 is NXDOMAIN; anything non-zero means no usable answer.
  if (Status !== 0) throw new Error(`resolver status ${String(Status)}`);
  const addresses: ResolvedAddress[] = [];
  let ttlMs = MAX_TTL_MS;
  for (const answer of Array.isArray(Answer) ? Answer : []) {
    if (!answer || typeof answer !== 'object') continue;
    const { type, data, TTL } = answer as { type?: unknown; data?: unknown; TTL?: unknown };
    if (type !== record.type || typeof data !== 'string') continue;
    if (net.isIP(data) !== record.family) continue;
    addresses.push({ address: data, family: record.family });
    if (typeof TTL === 'number' && Number.isFinite(TTL)) ttlMs = Math.min(ttlMs, TTL * 1000);
  }
  return { addresses, ttlMs };
}

/**
 * Every A and AAAA address the resolver gives for `hostname`, IPv4 first. Throws when it
 * gives none. Answers are cached for their TTL, kept between 30 seconds and 5 minutes.
 */
export async function resolveWithDoh(
  hostname: string,
  dohUrl: string,
  fetchImpl: FetchLike,
  readBody: (response: Response, maxBytes: number) => Promise<Buffer>,
  signal: AbortSignal,
): Promise<ResolvedAddress[]> {
  if (!isUsableDohUrl(dohUrl)) throw new Error('DNS over HTTPS resolver URL is not usable');
  const key = `${dohUrl}\n${hostname}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;

  const combined = AbortSignal.any([signal, AbortSignal.timeout(DOH_TIMEOUT_MS)]);
  let results: Array<{ addresses: ResolvedAddress[]; ttlMs: number } | null>;
  try {
    results = await Promise.all(
      RECORD_TYPES.map((record) =>
        queryType(
          hostname,
          new URL(dohUrl),
          record,
          fetchImpl,
          (response) => readBody(response, MAX_DOH_RESPONSE_BYTES),
          combined,
        ).catch((error: unknown) => {
          // One record type failing (a resolver without AAAA support, say) is fine as long
          // as the other answers; a caller abort is not.
          if (signal.aborted) throw error;
          return null;
        }),
      ),
    );
  } catch {
    signal.throwIfAborted();
    throw new Error(`DNS over HTTPS lookup failed for ${hostname}`);
  }
  const addresses = results.flatMap((result) => result?.addresses ?? []);
  if (addresses.length === 0) {
    throw new Error(`DNS over HTTPS lookup failed for ${hostname}`);
  }
  const ttlMs = Math.max(
    MIN_TTL_MS,
    Math.min(...results.map((result) => result?.ttlMs ?? MAX_TTL_MS)),
  );
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { addresses, expiresAt: Date.now() + ttlMs });
  return addresses;
}
