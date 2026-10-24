import dns from 'dns/promises';
import dnsCallback from 'dns';
import net from 'net';
import http from 'http';
import https from 'https';

/**
 * Blocks requests to private, loopback, link-local, and other non-public IP ranges so
 * client-suppliable URLs (image proxy, thumbnail sync) can't be used to reach internal
 * network services or cloud metadata endpoints. Public image hosts are unaffected.
 */

export class UnsafeUrlError extends Error {
  constructor(message = 'URL resolves to a disallowed address') {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * An IPv4-mapped IPv6 address as its four dotted octets, or null.
 *
 * Both spellings have to be handled: `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same
 * loopback address, and Node's `net.isIPv6` accepts both. Decoding only the dotted form
 * would leave the hex form unrecognised and classified as "public", bypassing the guard.
 */
function unmapIpv4(normalized: string): string | null {
  if (!normalized.startsWith('::ffff:')) {
    return null;
  }
  const suffix = normalized.slice('::ffff:'.length);

  if (net.isIPv4(suffix)) {
    return suffix;
  }

  // Hex form: one or two groups encoding the 32 bits, e.g. 7f00:1 or 7f00:0001.
  const groups = suffix.split(':');
  if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  const [high, low] = groups.map((g) => parseInt(g, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

const IPV4_NON_PUBLIC_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

const IPV6_NON_PUBLIC_RANGES = [
  '::/128',
  '::1/128',
  '::/96',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  '3fff::/20',
  '5f00::/16',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
] as const;

function addressValue(ip: string, family: 4 | 6): bigint {
  if (family === 4) {
    return ip.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
  }

  const normalized = ip.toLowerCase();
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  const ipv6 = embeddedIpv4
    ? normalized.replace(
        embeddedIpv4[1],
        (() => {
          const value = addressValue(embeddedIpv4[1], 4);
          return `${Number((value >> 16n) & 0xffffn).toString(16)}:${Number(value & 0xffffn).toString(16)}`;
        })(),
      )
    : normalized;
  const halves = ipv6.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = [
    ...left,
    ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'),
    ...right,
  ];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function isInRange(ip: string, range: string, family: 4 | 6): boolean {
  const [network, prefixText] = range.split('/');
  const prefix = Number(prefixText);
  const bits = family === 4 ? 32n : 128n;
  const shift = bits - BigInt(prefix);
  return addressValue(ip, family) >> shift === addressValue(network, family) >> shift;
}

/** Shared by URL preflight and the socket lookup used for the actual connection. */
export function isDisallowedIpAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return IPV4_NON_PUBLIC_RANGES.some((range) => isInRange(ip, range, 4));
  if (!net.isIPv6(ip)) return true;

  // A zone id ("fe80::1%eth0") only exists on link-local addresses, which are never public.
  // It also can't be parsed as hex, and this runs inside a socket lookup callback where a
  // throw would escape the request — so anything unparsable is refused, not thrown.
  if (ip.includes('%')) return true;
  const normalized = ip.toLowerCase();
  try {
    const mapped = unmapIpv4(normalized);
    if (mapped !== null) return isDisallowedIpAddress(mapped);
    return IPV6_NON_PUBLIC_RANGES.some((range) => isInRange(normalized, range, 6));
  } catch {
    return true;
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  return isDisallowedIpAddress(ip);
}

/** `URL.hostname` keeps the brackets around an IPv6 literal (`[::1]`), which `net.isIP`
 * does not accept. */
function unbracketHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Synchronous check usable in axios's `beforeRedirect` hook: blocks a redirect hop
 * that points straight at a private/reserved IP literal. It only catches literals; the
 * authoritative check is `guardedHttpAgent`, which validates the address each connection
 * actually uses. */
export function isDisallowedRedirectHost(rawHostname: string): boolean {
  const hostname = unbracketHost(rawHostname);
  return net.isIP(hostname) ? isPrivateOrReservedIp(hostname) : hostname === 'localhost';
}

/**
 * A `lookup` implementation for Node's HTTP agents that rejects any resolved address in a
 * private or reserved range.
 *
 * This is the only check in this file that can't be bypassed, because it runs when the
 * socket is about to connect, on the exact address being connected to. It covers what
 * `assertPublicHttpUrl` cannot:
 *
 * - **Redirects.** `beforeRedirect` only sees a hostname, so a redirect to a hostname that
 *   resolves to 127.0.0.1 would pass it.
 * - **TOCTOU.** A hostname validated by `assertPublicHttpUrl` can resolve differently by
 *   request time (DNS rebinding). Validating during lookup removes that window.
 *
 * Pass the agents below as axios's `httpAgent`/`httpsAgent` on any request whose URL came
 * from outside this app.
 */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dnsCallback.lookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err, address as string, family as number);
      return;
    }

    const addresses = Array.isArray(address)
      ? (address as { address: string }[]).map((entry) => entry.address)
      : [address as string];

    const blocked = addresses.find((candidate) => isPrivateOrReservedIp(candidate));
    if (blocked) {
      callback(new UnsafeUrlError(`Refusing to connect to ${hostname} (${blocked})`), '', 0);
      return;
    }

    callback(null, address as string, family as number);
  });
};

export const guardedHttpAgent = new http.Agent({ lookup: guardedLookup });
export const guardedHttpsAgent = new https.Agent({ lookup: guardedLookup });

/**
 * One-off agents that open a brand-new connection and close it afterwards. Some CDNs
 * (Cloudflare in particular) start refusing a pooled keep-alive connection after a burst
 * of requests and keep refusing it for as long as it is reused; a retry on a fresh
 * connection is what gets through. Same address guard as the shared agents.
 */
export function freshGuardedAgents(): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  return {
    httpAgent: new http.Agent({ lookup: guardedLookup, keepAlive: false }),
    httpsAgent: new https.Agent({ lookup: guardedLookup, keepAlive: false }),
  };
}

/** Throws UnsafeUrlError if the URL's protocol isn't http(s) or its host resolves to a
 * private/reserved IP. Callers should fetch the URL right after calling this — DNS can
 * change between calls (TOCTOU), so this is defense-in-depth, not an absolute guarantee. */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Unsupported URL protocol');
  }

  const hostname = unbracketHost(parsed.hostname);
  if (hostname === 'localhost') {
    throw new UnsafeUrlError('URL resolves to a disallowed address');
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new UnsafeUrlError('URL resolves to a disallowed address');
    }
    return parsed;
  }

  let addresses: string[];
  try {
    addresses = (await dns.lookup(hostname, { all: true })).map((a) => a.address);
  } catch {
    throw new UnsafeUrlError('Could not resolve URL host');
  }

  if (addresses.length === 0 || addresses.some(isPrivateOrReservedIp)) {
    throw new UnsafeUrlError('URL resolves to a disallowed address');
  }

  return parsed;
}
