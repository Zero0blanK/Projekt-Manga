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
const CURRENT = [STATIC_CACHE, PAGES_CACHE, DATA_CACHE, IMAGES_CACHE];
const OFFLINE_PAGE = '/offline.html';

const MAX_ENTRIES = {
  [STATIC_CACHE]: 600,
  [PAGES_CACHE]: 60,
  [DATA_CACHE]: 400,
  [IMAGES_CACHE]: 1500,
};

/** The API's base URL ("https://host/api"), from the registration URL. */
const API_BASE = (() => {
  const value = new URL(self.location.href).searchParams.get('api');
  return value ? value.replace(/\/+$/, '') : null;
})();

/** API paths that must always go to the network. */
const NETWORK_ONLY_API = [
  /^\/source\/(?!image-proxy)/,
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

// The page lists the code it loaded before this worker took control (first visit).
self.addEventListener('message', (event) => {
  const data = event.data;
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
    if (/^\/source\/image-proxy|^\/cache\/thumbnail/.test(path)) {
      event.respondWith(cacheFirst(request, IMAGES_CACHE));
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

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) void put(cache, cacheName, request, response.clone());
  return response;
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
