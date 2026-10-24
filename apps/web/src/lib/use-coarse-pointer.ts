'use client';

import { useSyncExternalStore } from 'react';

const COARSE_POINTER_QUERY = '(pointer: coarse)';

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const media = window.matchMedia(COARSE_POINTER_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** True on touch-first devices, where "press Space" and "right-click" mean nothing. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () =>
      (typeof window !== 'undefined' && window.matchMedia?.(COARSE_POINTER_QUERY).matches) || false,
    () => false,
  );
}
