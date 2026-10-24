'use client';

import { QueryClient } from '@tanstack/react-query';
import { clearAllBrowseSnapshots } from './browse-state';

/**
 * One QueryClient for the whole app, created at module scope.
 *
 * Next.js docs recommend creating the client inside a component when the same process
 * serves multiple users, so one request's cache can't leak into another's. That doesn't
 * apply here: every query runs in the browser (the web app fetches client-side so the
 * desktop app's local data bridge can intercept), so there is exactly one user per client
 * instance.
 *
 * Module scope is what makes `libraryActions` and `sessionActions` work: those are plain
 * functions called from event handlers, not hooks, and they need to read and invalidate
 * the same cache the components render from.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Manga catalogs and library state don't change behind the reader's back often
      // enough to justify refetching on every focus, and a refetch storm on window focus
      // is exactly the kind of traffic the sources rate-limit.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** Query keys in one place so an action's invalidation and a hook's subscription can't
 * drift apart — a mismatch there fails silently as a view that just never updates. */
export const queryKeys = {
  mangaLibrary: ['manga-library'] as const,
  libraryState: ['library-state'] as const,
  sources: ['sources'] as const,
  session: ['session'] as const,
  extensionRepositories: ['extension-repositories'] as const,
  installedExtensions: ['installed-extensions'] as const,
  sourceBrowse: (sourceIds: string[], category: string, filters: unknown) =>
    ['source-browse', sourceIds.join(','), category, filters] as const,
  sourceCapabilities: (sourceId: string | null) => ['source-capabilities', sourceId] as const,
  sourceFilters: (sourceId: string | null) => ['source-filters', sourceId] as const,
};

/** Reader writes are frequent. Avoid refetching the always-mounted app-shell query
 * while reading, but refresh if a late write finishes after returning to the library. */
export function invalidateSavedReadingProgress(): void {
  const libraryVisible =
    typeof window !== 'undefined' &&
    (window.location.pathname === '/' || window.location.pathname === '/bookmarks');
  void queryClient.invalidateQueries({
    queryKey: queryKeys.mangaLibrary,
    refetchType: libraryVisible ? 'active' : 'none',
  });
}

/**
 * Everything whose answer depends on *which sources are installed*.
 *
 * Installing or removing a source has to reach further than the source list itself. The
 * per-source catalog and filter queries are keyed by source id, so a browse attempted
 * before the source existed leaves a cached **failure** under exactly the key the same
 * page will read once it does exist — and with a 60s staleTime that error is served back
 * for a minute after the install succeeded. Invalidating by prefix marks those stale too,
 * which is what makes a freshly installed source browsable immediately rather than
 * eventually.
 *
 * Listed as key prefixes rather than exact keys because the browse/filters keys carry the
 * source id and filter object; `invalidateQueries` matches on prefix.
 */
const SOURCE_DEPENDENT_KEY_PREFIXES = [
  queryKeys.sources,
  queryKeys.installedExtensions,
  queryKeys.extensionRepositories,
  ['source-browse'],
  ['source-filters'],
  ['source-capabilities'],
] as const;

/**
 * Marks every source-dependent query stale after the installed set changes.
 *
 * Active queries refetch immediately; inactive ones refetch when their screen next mounts,
 * which is the behaviour that matters here — the reader installs on Discover and the
 * browse page is not mounted yet.
 */
export function invalidateSourceDependentQueries(): Promise<void> {
  clearAllBrowseSnapshots();
  return Promise.all(
    SOURCE_DEPENDENT_KEY_PREFIXES.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey: [...queryKey] }),
    ),
  ).then(() => undefined);
}
