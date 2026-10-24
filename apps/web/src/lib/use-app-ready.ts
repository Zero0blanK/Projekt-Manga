'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * When the document itself has finished loading — every subresource in, and webfonts
 * resolved.
 *
 * Fonts matter here specifically because the splash and the app both render display type:
 * handing over before they're ready swaps the typeface a beat after the splash lifts,
 * which reads as a second, uglier load.
 */
export function useDocumentReady(): boolean {
  const [loaded, setLoaded] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    if (document.readyState === 'complete') {
      setLoaded(true);
    } else {
      const onLoad = () => setLoaded(true);
      window.addEventListener('load', onLoad);
      return () => window.removeEventListener('load', onLoad);
    }
  }, []);

  useEffect(() => {
    // `document.fonts` is absent in a handful of environments; treat that as ready rather
    // than stalling the splash forever on a check that can never resolve.
    if (typeof document === 'undefined' || !('fonts' in document)) {
      setFontsReady(true);
      return;
    }
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return loaded && fontsReady;
}

type SeedStatus = 'idle' | 'running' | 'done' | 'failed';

/** Mirrors DesktopInitState in apps/desktop/src/main/init-state.ts. Duplicated rather than
 * imported: apps/web must not depend on apps/desktop. */
interface DesktopInitState {
  seedStatus: SeedStatus;
  hadLocalData: boolean;
  seededManga: number;
}

interface InitBridge {
  getState: () => Promise<{ success: boolean; data?: DesktopInitState }>;
}

function initBridge(): InitBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { desktop?: { init?: InitBridge } }).desktop?.init ?? null;
}

/** Fast enough that the splash lifts promptly once the seed lands, cheap enough to be
 * irrelevant — it is an in-memory read over IPC, and it stops as soon as it resolves. */
const INIT_POLL_MS = 150;

/**
 * Whether the desktop shell has finished the startup work the first screen depends on.
 *
 * Always true in a plain browser, where there is no local database to populate and the
 * pages fetch over HTTP like any web app.
 *
 * On desktop the library is read from a local SQLite file that is *seeded from the API in
 * the background at launch* (apps/desktop/src/main/index.ts). That read answers in
 * milliseconds whether or not the seed has written anything yet, so on a launch that began
 * with an empty database the splash would see a resolved-but-empty library, call the app
 * ready, and hand over to a blank page that fills in a few seconds later. Waiting here
 * keeps the splash up for that initialisation.
 *
 * Deliberately does *not* wait when the database already had titles: those render
 * immediately, and the seed is only refreshing them. `onSeedComplete` is how that case
 * still gets its refresh — see AppShell.
 */
export function useDesktopInitReady(onSeedComplete?: () => void): boolean {
  const [ready, setReady] = useState(() => initBridge() === null);

  const finish = useCallback(
    (seeded: boolean) => {
      setReady(true);
      if (seeded) onSeedComplete?.();
    },
    [onSeedComplete],
  );

  useEffect(() => {
    const bridge = initBridge();
    if (!bridge) {
      setReady(true);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled) return;
      try {
        const { data } = await bridge.getState();
        if (cancelled || !data) return;

        // Nothing to wait for: the library is already on disk, so hold only until the seed
        // *starts* reporting, then let the app render and refresh underneath.
        if (data.hadLocalData) {
          setReady(true);
          if (data.seedStatus === 'done') onSeedComplete?.();
          else timer = setTimeout(() => void poll(), INIT_POLL_MS);
          return;
        }

        // 'failed' resolves the wait too — an unreachable API is an ordinary state for a
        // local-first app, and the splash must not sit on a seed that will never arrive.
        if (data.seedStatus === 'done' || data.seedStatus === 'failed') {
          finish(data.seedStatus === 'done');
          return;
        }

        timer = setTimeout(() => void poll(), INIT_POLL_MS);
      } catch {
        // The bridge answering at all is not something the splash should depend on.
        setReady(true);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [finish, onSeedComplete]);

  return ready;
}
