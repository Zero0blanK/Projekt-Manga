/*
 * Projekt Manga's service worker: lets the web app open, and the library be browsed, with
 * no connection. Registered by src/lib/service-worker.ts (browser, production, HTTPS or
 * localhost only).
 *
 * - The app's own code, fonts and images never change at a given URL, so they come from
 *   the cache first.
 * - Pages and library data come from the network first, so they are never staler than
 *   they need to be, and from the cache when the network or the server can't answer.
 * - Sources, sign-in and live event streams are never cached: browsing sources needs the
 *   internet anyway, and a stale answer there would mislead.
 *
 * Bump VERSION when this file's caching rules change; older caches are then deleted.
 */
const VERSION = 'v1';
const STATIC_CACHE = `pm-static-${VERSION}`;
const PAGES_CACHE = `pm-pages-${VERSION}`;
/** Keep in step with DATA_CACHES in src/lib/service-worker.ts, which clears them when the account changes. */
const DATA_CACHE = `pm-data-${VERSION}`;
const IMAGES_CACHE = `pm-images-${VERSION}`;
/** Pages of downloaded chapters, kept apart so covers never push them out (or the reverse). */
const CHAPTERS_CACHE = `pm-chapters-${VERSION}`;
const CURRENT = [STATIC_CACHE, PAGES_CACHE, DATA_CACHE, IMAGES_CACHE, CHAPTERS_CACHE];
const OFFLINE_PAGE = '/offline.html';

const MAX_ENTRIES = {
  [STATIC_CACHE]: 600,
  [PAGES_CACHE]: 60,
  [DATA_CACHE]: 400,
  [IMAGES_CACHE]: 3000,
  [CHAPTERS_CACHE]: 3000,
};

/** The API's base URL ("https://host/api"), from the registration URL. */
const API_BASE = (() => {
  const value = new URL(self.location.href).searchParams.get('api');
  return value ? value.replace(/\/+$/, '') : null;
})();

/** API paths that must always go to the network. */
const NETWORK_ONLY_API = [
  // Except covers and pages through the image proxy, and a chapter's page list: a chapter
  // read before should open again offline.
  /^\/source\/(?!image-proxy|[^/]+\/chapter\/[^/]+\/pages$)/,
  /^\/auth\/(?!me$)/,
  /^\/extension/,
  /^\/suwayomi/,
  /^\/health/,
  /^\/sync\//,
  /^\/restore\//,
  /^\/translate/,
  /events|stream/,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PAGES_CACHE)
      .then((cache) => cache.add(OFFLINE_PAGE))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('pm-') && !CURRENT.includes(name))
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'cache-covers' && Array.isArray(data.urls)) {
    event.waitUntil(cacheCovers(data.urls.filter((url) => typeof url === 'string')));
    return;
  }
  // The page lists the code it loaded before this worker took control (first visit).
  if (!data || data.type !== 'cache-assets' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        Promise.all(
          data.urls
            .filter(
              (url) => typeof url === 'string' && new URL(url).origin === self.location.origin,
            )
            .map((url) =>
              cache.match(url).then((hit) => hit || cache.add(url).catch(() => undefined)),
            ),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (API_BASE && (request.url === API_BASE || request.url.startsWith(`${API_BASE}/`))) {
    const path = request.url.slice(API_BASE.length).split('?')[0];
    if (request.headers.get('accept')?.includes('text/event-stream')) return;
    if (/^\/cache\/thumbnail\//.test(path)) {
      event.respondWith(cover(request));
      return;
    }
    if (/^\/source\/image-proxy/.test(path)) {
      event.respondWith(cacheFirst(request, IMAGES_CACHE));
      return;
    }
    // A downloaded chapter's page never changes at its URL.
    if (/^\/downloads\/chapter\/[^/]+\/page\//.test(path)) {
      event.respondWith(cacheFirst(request, CHAPTERS_CACHE));
      return;
    }
    if (NETWORK_ONLY_API.some((rule) => rule.test(path))) return;
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/brand/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  if (url.pathname.startsWith('/_next/image')) {
    event.respondWith(cacheFirst(request, IMAGES_CACHE));
    return;
  }
  // Router data requests: offline, they fail, and Next falls back to a full page load,
  // which the navigation rule below answers from the cache.
  if (request.headers.get('RSC') === '1' || url.searchParams.has('_rsc')) return;
  if (request.mode === 'navigate') {
    event.respondWith(page(request));
  }
});

/** Library covers come in widths (`?w=200|400|800`, see src/components/cover.tsx). */
const COVER_WIDTHS = [200, 400, 800];

function atWidth(url, width) {
  const next = new URL(url);
  if (width === null) next.searchParams.delete('w');
  else next.searchParams.set('w', String(width));
  return next.href;
}

/**
 * A library cover from this device when there is one: the exact width, or failing that a
 * larger one of the same cover (sharper than needed, never blurrier), or offline, any.
 * Covers are versioned in their URL, so a cached one is never out of date.
 */
async function cover(request) {
  const cache = await caches.open(IMAGES_CACHE);
  const exact = await cache.match(request, { ignoreVary: true });
  if (exact) return exact;
  const wanted = Number(new URL(request.url).searchParams.get('w')) || null;
  const larger = wanted ? COVER_WIDTHS.filter((w) => w > wanted) : [];
  for (const width of [...larger, null]) {
    const hit = await cache.match(atWidth(request.url, width), { ignoreVary: true });
    if (hit) return hit;
  }
  try {
    const response = await fetch(readable(request));
    if (response.ok) void put(cache, IMAGES_CACHE, request, response.clone());
    return response;
  } catch (error) {
    for (const width of COVER_WIDTHS) {
      const hit = await cache.match(atWidth(request.url, width), { ignoreVary: true });
      if (hit) return hit;
    }
    throw error;
  }
}

/**
 * Keeps a small copy of every library cover on this device (asked for by
 * src/lib/cover-cache.ts once the library has loaded), so the whole library shows its
 * covers at once, and offline. Four at a time, skipping any already here.
 */
async function cacheCovers(urls) {
  const cache = await caches.open(IMAGES_CACHE);
  const queue = urls.slice();
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        if (await cache.match(url, { ignoreVary: true })) continue;
        const response = await fetch(url, { credentials: 'include', mode: 'cors' });
        if (response.ok) await cache.put(url, response);
      } catch {
        // Offline again, or one cover refused: the rest still get their turn.
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(readable(request));
  if (response.ok) void put(cache, cacheName, request, response.clone());
  return response;
}

/**
 * An <img> from another origin (the API, when it isn't served from this one) is fetched
 * "no-cors", and its answer is opaque: no status to check, so it was never kept, and the
 * pages of a chapter read before couldn't open offline. The API allows this origin, so
 * the same URL is fetched with CORS instead, which an <img> accepts just as well.
 */
function readable(request) {
  if (request.mode !== 'no-cors' || new URL(request.url).origin === self.location.origin)
    return request;
  return new Request(request.url, { mode: 'cors', credentials: 'include' });
}

/** The network's answer when there is one; the cache's when it fails or the server errs. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      void put(cache, cacheName, request, response.clone());
      return response;
    }
    if (response.status >= 500) return (await cache.match(request)) || response;
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

async function page(request) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      void put(cache, PAGES_CACHE, request, response.clone());
    }
    return response;
  } catch {
    return (
      (await cache.match(request)) ||
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match(OFFLINE_PAGE)) ||
      Response.error()
    );
  }
}

async function put(cache, cacheName, request, response) {
  try {
    await cache.put(request, response);
    const keys = await cache.keys();
    const excess = keys.length - (MAX_ENTRIES[cacheName] ?? 500);
    // Oldest first: keys come back in insertion order.
    for (let i = 0; i < excess; i++) {
      if (keys[i].url.endsWith(OFFLINE_PAGE)) continue;
      await cache.delete(keys[i]);
    }
  } catch {
    // Quota: the response is still served, only not kept.
  }
}
