'use client';

import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { applyRuntimeApiBaseUrl } from '@/lib/api-config';
import {
  isStaticDataQuery,
  persistStaticDataCache,
  restoreStaticDataCache,
} from '@/lib/startup-static-data';

// At module scope, not in an effect: this has to run before the first request, and every
// query in this app is issued from below this provider. An effect would fire after the
// first render has already kicked queries off against the wrong base URL.
applyRuntimeApiBaseUrl();

/** Wraps the app in the shared client from lib/query-client. Split into its own file so
 * the root layout stays a Server Component. */
export function QueryProvider({ children }: { children: ReactNode }) {
  // Hydrate after React attaches to the server HTML but before normal effects start query
  // observers. That avoids a server/client markup mismatch while still preventing the
  // first Sources or Extensions screen from issuing a duplicate request.
  useLayoutEffect(() => {
    restoreStaticDataCache(queryClient);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== 'updated' ||
        event.action.type !== 'success' ||
        !isStaticDataQuery(event.query.queryKey)
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => persistStaticDataCache(queryClient), 0);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
