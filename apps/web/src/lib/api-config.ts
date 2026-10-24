'use client';

import { configureApiClient } from '@projekt-manga/api-client';

/**
 * Runtime API base URL, applied before the first request.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time, so a bundle built for one deployment
 * carries that deployment's host and port forever. The desktop installer can't live with
 * that: it picks free ports at launch. This is the escape hatch — the main process hands
 * a base URL to the preload, which exposes it here, and it wins over the baked-in value.
 *
 * In a plain browser `window.desktop` is undefined and nothing happens, which is what
 * keeps apps/web working with no Electron APIs present.
 */

interface DesktopApiConfigBridge {
  apiBaseUrl?: string;
}

/** Idempotent: the module is evaluated once, but an explicit guard costs nothing and
 * makes the invariant ("configure exactly once, before any request") visible. */
let applied = false;

export function applyRuntimeApiBaseUrl(): void {
  if (applied || typeof window === 'undefined') return;
  applied = true;

  const bridge = (window as { desktop?: DesktopApiConfigBridge }).desktop;
  const baseUrl = bridge?.apiBaseUrl?.trim();
  if (!baseUrl) return;

  configureApiClient({ baseUrl });
}
