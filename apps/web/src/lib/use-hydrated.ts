'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False while the server renders and while the page hydrates, true on every client render
 * after that, including the first render of something mounted by client-side navigation.
 *
 * A `useState(false)` + `useEffect` pair gives the same safe first render for hydration,
 * but also makes every later mount start empty for a render, so cached data blinks out on
 * each visit to a page.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
