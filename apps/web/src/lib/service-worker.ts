'use client';

import { getApiBaseUrl, hasLocalDataBridge } from '@projekt-manga/api-client';
import { desktopBridge } from './desktop-bridge';

/**
 * The service worker (public/sw.js) that lets the web app open without a connection.
 *
 * Browser only, and only in a production build: the desktop app reads the library from its
 * own database already, and a worker caching a dev server's code would serve stale builds.
 * Browsers only allow it on HTTPS or localhost; elsewhere (plain HTTP on a LAN) this does
 * nothing, and the on-device library copy (offline-library.ts) still works.
 */

/** Keep in step with DATA_CACHE in public/sw.js. */
const DATA_CACHES = ['pm-data-v1', 'pm-images-v1', 'pm-chapters-v1'];

function supported(): boolean {
  return (
    process.env.NODE_ENV === 'production' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    window.isSecureContext &&
    !desktopBridge() &&
    !hasLocalDataBridge()
  );
}

export async function registerServiceWorker(): Promise<void> {
  if (!supported()) return;
  // The API may be on another origin; the worker needs to know which requests are its.
  const api = new URL(getApiBaseUrl(), window.location.href).href;
  try {
    await navigator.serviceWorker.register(`/sw.js?api=${encodeURIComponent(api)}`, {
      scope: '/',
    });
    const registration = await navigator.serviceWorker.ready;
    // The code this page already loaded came before the worker could see it: hand the
    // worker the list so the app opens offline after this first visit too.
    const assets = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => new URL(url).origin === window.location.origin)
      .filter((url) => /\/_next\/static\//.test(url));
    registration.active?.postMessage({ type: 'cache-assets', urls: assets });
  } catch {
    // Unsupported or refused: the app works as before, just not offline.
  }
}

/** The account changed: what was cached for the last one goes. */
export async function clearOfflineDataCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all(DATA_CACHES.map((name) => caches.delete(name).catch(() => false)));
}
