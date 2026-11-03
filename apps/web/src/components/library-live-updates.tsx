'use client';

import { useEffect } from 'react';
import { subscribeToLibraryChanges } from '@projekt-manga/api-client';
import { queryClient } from '@/lib/query-client';
import { useCurrentUser } from '@/lib/session-resource';

/** Query keys that describe sources and extensions, not library data. */
const NOT_LIBRARY = new Set([
  'sources',
  'installed-extensions',
  'extension-repositories',
  'source-browse',
  'source-filters',
  'source-capabilities',
  'suwayomi',
  'session',
]);

/**
 * Keeps this window's library in step with every other app on the same library: a chapter
 * read in the desktop app shows as read in an open browser tab, and the other way round,
 * without a reload. Reconnects when the reader signs in or out, since that changes whose
 * library is being watched.
 */
export function LibraryLiveUpdates() {
  const { user } = useCurrentUser();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    return subscribeToLibraryChanges(() => {
      void queryClient.invalidateQueries({
        predicate: (query) => !NOT_LIBRARY.has(String(query.queryKey[0])),
      });
    });
  }, [userId]);
  return null;
}
