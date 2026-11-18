'use client';

import { coverAtWidth } from './cover-url';
import type { Manga } from './manga-data';

/**
 * A small copy of every library cover on this device.
 *
 * Covers used to download as each one scrolled into view, so a large library showed
 * loading rings for a while, and offline only the covers already seen. Once the library
 * has loaded, this asks the offline worker (public/sw.js) to keep each one at 400px: about
 * 20-40KB as WebP, sharp in a grid card even on a high-density screen, and served for the
 * smaller widths too. After that, the whole library opens with its covers in milliseconds,
 * with or without a connection.
 *
 * Only where the worker runs (see service-worker.ts). Each cover is asked for once per
 * page load; the worker skips any it already has.
 */

/** Covers are versioned in their URL, so a new cover is a new URL and is fetched again. */
const asked = new Set<string>();
const KEEP_WIDTH = 400;

function idle(run: () => void) {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run);
  else setTimeout(run, 1000);
}

export function keepLibraryCovers(library: Manga[]): void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  if (!navigator.onLine) return;
  const urls: string[] = [];
  for (const title of library) {
    if (!title.thumbnailUrl) continue;
    const url = new URL(coverAtWidth(title.thumbnailUrl, KEEP_WIDTH), window.location.href).href;
    if (asked.has(url)) continue;
    asked.add(url);
    urls.push(url);
  }
  if (urls.length === 0) return;
  // After the first screen has what it needs: this is a background job. `ready` waits for
  // the worker on a first visit, and never settles where there is none, which is harmless.
  void navigator.serviceWorker.ready.then((registration) =>
    idle(() => registration.active?.postMessage({ type: 'cache-covers', urls })),
  );
}
