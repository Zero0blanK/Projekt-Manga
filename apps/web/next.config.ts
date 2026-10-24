import type { NextConfig } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

/**
 * Single-origin mode: `NEXT_PUBLIC_API_URL` is a path (`/api`) rather than an absolute
 * URL, so the browser reaches the API through this app's own origin and src/proxy.ts
 * forwards it onward at request time.
 *
 * This is what the desktop installer builds with, and it is the whole reason the API's
 * port can be picked at runtime — a relative base URL has no port in it to bake in. It
 * also means `new URL(API_URL)` throws, so every helper here has to be guarded on it.
 */
function isRelativeApiUrl(url: string): boolean {
  return url.startsWith('/');
}

/**
 * Covers come from this app's guarded image proxy or its private thumbnail cache,
 * never directly from a source host. Only those two API paths are allowlisted.
 *
 * Derived from the same env var the api-client reads. Both are resolved at build time
 * (Next inlines `NEXT_PUBLIC_*`), so the two can't disagree at runtime.
 *
 * `search` is deliberately not set: the proxy carries its target in the query string, and
 * a defined `search` is matched exactly, which would reject every real cover URL.
 */
function apiCoverPatterns() {
  const { protocol, hostname, port } = new URL(API_URL);
  const origin = {
    protocol: protocol.replace(':', '') as 'http' | 'https',
    hostname,
    port,
  };
  return [
    { ...origin, pathname: '/api/source/image-proxy' },
    { ...origin, pathname: '/api/cache/thumbnail/**' },
  ];
}

/**
 * Whether the API is reached at an address Next's image optimizer treats as private.
 *
 * Loopback and RFC1918 both count. This is the normal case for this project rather than
 * an edge one: the API is a process you run yourself, so it's on localhost for a desktop
 * install and typically on a LAN address for a self-hosted server.
 */
function apiIsLocalAddress(): boolean {
  // Single-origin mode never reaches here (see the call site) — but the guard keeps this
  // helper safe to call, since `new URL('/api')` throws rather than returning a hostname.
  if (isRelativeApiUrl(API_URL)) return false;

  const { hostname } = new URL(API_URL);
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const nextConfig: NextConfig = {
  transpilePackages: [
    '@projekt-manga/api-client',
    '@projekt-manga/schemas',
    '@projekt-manga/types',
  ],
  /**
   * No `rewrites()` here on purpose.
   *
   * The API proxy lives in src/proxy.ts instead. `rewrites()` is evaluated during
   * `next build` and its result is baked into .next/routes-manifest.json, so reading
   * `process.env` inside it would capture the build machine's value and defeat runtime
   * port selection. See src/proxy.ts.
   */
  images: {
    /**
     * Empty in single-origin mode: the proxied cover URL is a path (`/api/source/
     * image-proxy?...`), which `next/image` treats as a *local* image and never checks
     * against `remotePatterns`. A relative API URL can't be parsed by `new URL()` anyway.
     */
    remotePatterns: isRelativeApiUrl(API_URL) ? [] : apiCoverPatterns(),

    /**
     * Single-origin mode turns every cover into a *local* image, and Next 16 defaults
     * `localPatterns` to `[{ pathname: '**', search: '' }]` — any path, but **no query
     * string**. The proxy URL carries its target in `?url=`, so without this every cover
     * fails with a 400 `"url" parameter is not allowed`.
     *
     * Do not be misled by `hasLocalMatch` in next/dist/shared/lib/match-local-pattern.js,
     * which returns true when `localPatterns` is undefined: the config layer fills that
     * default in before the optimizer ever sees it, so the permissive branch is
     * unreachable from a real request.
     *
     * Setting it at all opts out of that default entirely, so the last entry has to
     * restore it for ordinary assets. `search` is omitted on the proxy entries for the same
     * reason it is omitted from `apiCoverPatterns()` above: a defined `search` is matched
     * exactly, which would reject every real cover URL.
     */
    localPatterns: isRelativeApiUrl(API_URL)
      ? [
          { pathname: '/api/source/image-proxy' },
          { pathname: '/api/cache/thumbnail/**' },
          { pathname: '/**', search: '' },
        ]
      : undefined,

    // Covers are displayed small and never at full bleed; capping the generated widths
    // keeps the optimizer from producing sizes nothing in this UI ever requests.
    //
    // The upper steps exist because grid cards are larger than list thumbnails and a HiDPI
    // screen doubles whatever they ask for. Without a candidate between 256 and
    // `deviceSizes`' 640, a card needing ~420px would have to choose between fetching a
    // third of what it displays or four times it.
    imageSizes: [32, 48, 64, 96, 128, 160, 200, 256, 320, 384, 448],

    /**
     * Next 16 narrows `qualities` to `[75]` by default, and a `quality` outside the list
     * is silently ignored rather than erroring — so components/cover.tsx asking for 85
     * needs it listed. 75 stays for everything else; covers are a second lossy encode of
     * an already-compressed source, which is where the extra few KiB pay for themselves.
     */
    qualities: [75, 85],

    /**
     * Next 16 refuses to optimize an upstream whose hostname resolves to a private IP,
     * as SSRF defence — and a self-hosted API is on localhost or a LAN address by
     * definition, so every cover would be rejected with a 400.
     *
     * Safe here, and only here, because of what it is combined with: this check runs
     * *after* `remotePatterns` (see next/dist/server/image-optimizer.js —
     * `fetchExternalImage` is only reached for an already-allowlisted URL), and the
     * patterns above use an exact protocol + host + port and narrow paths. The optimizer can
     * therefore only ever fetch this app's own proxy or cache endpoint; there is no input
     * that redirects it at another internal host, which is the attack the flag guards
     * against. The proxy itself then applies its own SSRF guard to the URL it is handed
     * (apps/server/src/utils/ssrfGuard.ts).
     *
     * Enabled only when the API genuinely is at a private address, so a deployment that
     * serves the API from a real domain keeps the check switched on. In single-origin
     * mode it stays off entirely: covers are local images by then, so the optimizer's
     * external-fetch path — the only thing this flag relaxes — is never taken.
     */
    dangerouslyAllowLocalIP: apiIsLocalAddress(),
  },
};

export default nextConfig;
