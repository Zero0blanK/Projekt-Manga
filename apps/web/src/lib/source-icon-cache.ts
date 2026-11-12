'use client';

import { useSyncExternalStore } from 'react';

/**
 * Each source's icon, kept in this browser so it shows at once.
 *
 * Without it a source's icon waited on two lists to load (installed sources and the
 * repositories' listings) on every visit, then on the image itself; a repository icon the
 * image proxy refuses (an SVG) or a request turned away by a rate limit showed the
 * lettered tile instead. The icon is stored as a data URL keyed by the source, with the
 * address it came from, and fetched again only when that address changes.
 *
 * Small by design: icons are a few kilobytes, anything large is shown but not kept, and
 * the oldest entries go once there are many.
 */

interface CachedIcon {
  url: string;
  data: string;
  savedAt: number;
}

const STORAGE_KEY = 'pm:source-icons:v1';
const MAX_ICON_BYTES = 96 * 1024;
const MAX_ENTRIES = 300;

let icons: Record<string, CachedIcon> | null = null;
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<RememberedIcon>>();

function load(): Record<string, CachedIcon> {
  if (icons) return icons;
  icons = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as Partial<CachedIcon> | null;
        if (
          typeof entry?.url === 'string' &&
          typeof entry.data === 'string' &&
          entry.data.startsWith('data:image/')
        ) {
          icons[key] = { url: entry.url, data: entry.data, savedAt: Number(entry.savedAt) || 0 };
        }
      }
    }
  } catch {
    // Unreadable or blocked storage: start empty.
  }
  return icons;
}

function save(next: Record<string, CachedIcon>) {
  const entries = Object.entries(next)
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX_ENTRIES);
  icons = Object.fromEntries(entries);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(icons));
  } catch {
    // Full or blocked storage: the icon still shows for this visit.
  }
  for (const listener of listeners) listener();
}

export function getCachedSourceIcon(key: string): CachedIcon | null {
  if (typeof window === 'undefined') return null;
  return load()[key] ?? null;
}

export function useCachedSourceIcon(key: string): CachedIcon | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getCachedSourceIcon(key),
    () => null,
  );
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * What fetching an icon came to: `kept` in the cache, `too-large` to keep (show it straight
 * from its address), or `unusable`: an error, not an image, or the image proxy's empty
 * placeholder for an image it refused.
 */
export type RememberedIcon = 'kept' | 'too-large' | 'unusable';

/** Fetches `url` and keeps it as `key`'s icon. */
export function rememberSourceIcon(key: string, url: string): Promise<RememberedIcon> {
  const pending = inFlight.get(`${key}\u0000${url}`);
  if (pending) return pending;
  const run = (async (): Promise<RememberedIcon> => {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return 'unusable';
      const blob = await response.blob();
      // The proxy answers a refused image with a 1×1 PNG of a few dozen bytes.
      if (!blob.type.startsWith('image/') || blob.size < 100) return 'unusable';
      if (blob.size > MAX_ICON_BYTES) return 'too-large';
      const data = await readAsDataUrl(blob);
      if (!data.startsWith('data:image/')) return 'unusable';
      save({ ...load(), [key]: { url, data, savedAt: Date.now() } });
      return 'kept';
    } catch {
      return 'unusable';
    } finally {
      inFlight.delete(`${key}\u0000${url}`);
    }
  })();
  inFlight.set(`${key}\u0000${url}`, run);
  return run;
}

/** For tests. */
export function resetSourceIconCache(): void {
  icons = null;
  inFlight.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
