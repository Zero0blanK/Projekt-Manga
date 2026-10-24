'use client';
import { useLayoutEffect, useRef } from 'react';
/** Restore the previous viewport when a reader returns to a chapter filter. */
export function useChapterFilterScroll(filterKey: string) {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const savedPositions = positions.current;
    const previous = savedPositions.get(filterKey);
    const frame =
      previous === undefined
        ? null
        : requestAnimationFrame(() => window.scrollTo({ top: previous, behavior: 'instant' }));
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      savedPositions.set(filterKey, window.scrollY);
      if (savedPositions.size > 40) savedPositions.delete(savedPositions.keys().next().value!);
    };
  }, [filterKey]);
}
