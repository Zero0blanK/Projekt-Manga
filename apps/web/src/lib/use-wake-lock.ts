'use client';

import { useEffect } from 'react';

/**
 * Settings > Reader > Keep screen awake. Holds a Screen Wake Lock while `enabled`, so a
 * long chapter isn't interrupted by the display sleeping.
 *
 * The lock is released by the browser whenever the tab is hidden and is *not* restored
 * automatically, so it's re-requested on every return to visibility. Unsupported browsers
 * (and insecure origins, where the API is absent) simply do nothing.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
 */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        /* denied (battery saver, no user activation) — reading still works */
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => {});
    };
  }, [enabled]);
}
