'use client';

import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { usePathname } from 'next/navigation';
import { LibraryLiveUpdates } from '@/components/library-live-updates';
import { CategorySync } from '@/components/category-sync';
import { SourceChallengeAutoOpen } from '@/components/source-challenge-auto-open';
import { ImportedReadStateSync } from '@/components/imported-read-state-sync';
import { applyRuntimeApiBaseUrl } from '@/lib/api-config';
import { installProgressOutbox } from '@/lib/progress-outbox';
import { installClientDiagnostics, recordPageVisit } from '@/lib/client-diagnostics';
import {
  isStaticDataQuery,
  persistStaticDataCache,
  restoreStaticDataCache,
} from '@/lib/startup-static-data';
import {
  checkSavedLibraryOwner,
  noteFreshLibrary,
  restoreSavedLibrary,
  saveLibrary,
} from '@/lib/offline-library';
import { queryKeys } from '@/lib/query-client';
import { keepLibraryCovers } from '@/lib/cover-cache';
import { keepDownloadsOffline } from '@/lib/offline-downloads';
import type { Manga } from '@/lib/manga-data';
import type { DownloadSummary, PublicUser } from '@projekt-manga/api-client';

// At module scope, not in an effect: this has to run before the first request, and every
// query in this app is issued from below this provider. An effect would fire after the
// first render has already kicked queries off against the wrong base URL.
applyRuntimeApiBaseUrl();
// Same reason: a request that fails during the first render is the one most worth seeing.
installClientDiagnostics();
// And progress read offline must have somewhere to wait before the reader first saves.
installProgressOutbox();

/** Wraps the app in the shared client from lib/query-client. Split into its own file so
 * the root layout stays a Server Component. */
export function QueryProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) recordPageVisit(pathname);
  }, [pathname]);

  // Hydrate after React attaches to the server HTML but before normal effects start query
  // observers. That avoids a server/client markup mismatch while still preventing the
  // first Sources or Extensions screen from issuing a duplicate request.
  useLayoutEffect(() => {
    restoreStaticDataCache(queryClient);
    void restoreSavedLibrary(queryClient);
  }, []);

  // Keeps the on-device copy of the library current (lib/offline-library.ts). Only answers
  // from the server count: the copy itself, and a first load's partial pages, are written
  // with setQueryData, which marks them manual.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual)
        return;
      const [key] = event.query.queryKey;
      if (key === queryKeys.session[0]) {
        checkSavedLibraryOwner(queryClient, (event.query.state.data as PublicUser | null) ?? null);
      } else if (key === queryKeys.mangaLibrary[0]) {
        noteFreshLibrary();
        keepLibraryCovers((event.query.state.data as Manga[] | undefined) ?? []);
      } else if (key === queryKeys.downloads[0]) {
        // Downloaded chapters, readable here offline (lib/offline-downloads.ts). Only the
        // list itself: other queries share the prefix (the statistics' download totals).
        const data = event.query.state.data;
        if (Array.isArray(data)) void keepDownloadsOffline(data as DownloadSummary[]);
        return;
      } else if (key !== queryKeys.libraryState[0]) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void saveLibrary(queryClient), 1000);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
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

  return (
    <QueryClientProvider client={queryClient}>
      <LibraryLiveUpdates />
      <CategorySync />
      <SourceChallengeAutoOpen />
      <ImportedReadStateSync />
      {children}
    </QueryClientProvider>
  );
}
