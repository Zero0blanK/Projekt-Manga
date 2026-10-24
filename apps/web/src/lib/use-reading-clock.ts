'use client';

import { useCallback, useEffect, useRef } from 'react';

/** A single uninterrupted stretch counts for at most this long. The tab being visible
 * isn't proof anyone is reading — without a ceiling, a reader left open overnight would
 * report as ten hours of reading. */
const MAX_SEGMENT_MS = 5 * 60_000;

/**
 * Measures time actually spent reading, for `history.time_read`.
 *
 * Counting only runs while the tab is visible. `takeElapsed()` returns the milliseconds
 * accrued since the previous call and resets the counter — the server *adds* what it
 * receives to the stored total, so every call must report an increment, never a running
 * total, or the time would compound.
 */
export function useReadingClock(): () => number {
  const accrued = useRef(0);
  const segmentStart = useRef<number | null>(null);

  const foldSegment = (restart: boolean) => {
    if (segmentStart.current !== null) {
      accrued.current += Math.min(Date.now() - segmentStart.current, MAX_SEGMENT_MS);
    }
    segmentStart.current = restart ? Date.now() : null;
  };

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (segmentStart.current === null) segmentStart.current = Date.now();
      } else {
        foldSegment(false);
      }
    };

    if (document.visibilityState === 'visible') segmentStart.current = Date.now();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      foldSegment(false);
    };
  }, []);

  return useCallback(() => {
    foldSegment(segmentStart.current !== null);
    const elapsed = Math.round(accrued.current);
    accrued.current = 0;
    return elapsed;
  }, []);
}
