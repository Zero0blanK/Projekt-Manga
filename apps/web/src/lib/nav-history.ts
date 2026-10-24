'use client';

/**
 * Tracks the previous in-app location so a detail page can offer a real "back" instead of
 * a hardcoded destination. Only the *previous* entry is needed — the actual navigation
 * uses router.back(), which is what restores scroll position and any state the page
 * itself persisted; this just answers "is there somewhere to go back to, and what is it
 * called".
 */
const KEY = 'projekt-manga:nav:previous';
const NAVIGATED_KEY = 'projekt-manga:nav:navigated';

export type PreviousLocation = { href: string; label: string };

/** Records that at least one in-app navigation has happened this session, so a screen can
 * tell "go back" (safe, and keeps the history stack tidy) from "there's nothing behind
 * this — it was opened directly". */
export function markNavigatedInApp() {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(NAVIGATED_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function hasNavigatedInApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(NAVIGATED_KEY) === '1';
  } catch {
    return false;
  }
}

const LABELS: Array<{ match: (path: string) => boolean; label: string }> = [
  { match: (p) => p === '/', label: 'library' },
  { match: (p) => p.startsWith('/discover/popular'), label: 'Popular' },
  { match: (p) => p.startsWith('/discover/latest'), label: 'Latest' },
  { match: (p) => p.startsWith('/discover/preview'), label: 'details' },
  { match: (p) => p.startsWith('/discover'), label: 'Discover' },
  { match: (p) => p.startsWith('/bookmarks'), label: 'Bookmarks' },
  { match: (p) => p.startsWith('/recents'), label: 'Recents' },
  { match: (p) => p.startsWith('/history'), label: 'History' },
  { match: (p) => p.startsWith('/downloads'), label: 'Downloads' },
  { match: (p) => p.startsWith('/notifications'), label: 'Notifications' },
  { match: (p) => p.startsWith('/settings'), label: 'Settings' },
  { match: (p) => /^\/manga\/[^/]+\/migrate$/.test(p), label: 'migration search' },
  { match: (p) => p.startsWith('/manga'), label: 'details' },
];

export function labelForPath(pathname: string): string {
  return LABELS.find((l) => l.match(pathname))?.label ?? 'back';
}

export function setPreviousLocation(href: string) {
  if (typeof window === 'undefined') return;
  try {
    const pathname = href.split('?')[0];
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ href, label: labelForPath(pathname) } satisfies PreviousLocation),
    );
  } catch {
    /* storage unavailable — back simply falls back to its default destination */
  }
}

/**
 * Forgets the recorded previous location when this document was not opened from inside
 * the app (a typed URL, a bookmark, a link from another site). sessionStorage outlives
 * those loads, so without this a title opened directly said "Back to Popular" from a
 * browse session earlier in the tab, while router.back() went somewhere else entirely.
 */
export function forgetPreviousLocationIfEnteredDirectly() {
  if (typeof window === 'undefined') return;
  let fromApp = false;
  try {
    fromApp = !!document.referrer && new URL(document.referrer).origin === window.location.origin;
  } catch {
    fromApp = false;
  }
  if (fromApp) return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — nothing was recorded either */
  }
}

export function getPreviousLocation(): PreviousLocation | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // Stored by a previous build or half-written: a cast alone would hand the back link a
    // `href` of undefined and navigate nowhere. Fall back to its default destination.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as PreviousLocation).href !== 'string' ||
      typeof (parsed as PreviousLocation).label !== 'string'
    ) {
      return null;
    }
    return parsed as PreviousLocation;
  } catch {
    return null;
  }
}
