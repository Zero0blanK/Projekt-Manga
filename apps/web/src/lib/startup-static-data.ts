'use client';

import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import {
  getSources,
  listExtensionRepositories,
  listInstalledExtensions,
  type ExtensionRepositoryWithListing,
  type InstalledExtension,
  type SourceSummary,
} from '@projekt-manga/api-client';
import { extensionListingEntrySchema } from '@projekt-manga/schemas';
import { z } from 'zod';
import { queryKeys } from './query-client';

/**
 * Sources and extension catalogues normally change only through an explicit extension
 * action. Keeping them fresh for six hours prevents a repository-index download every
 * time the application opens, while still giving a server-side automatic refresh a
 * bounded time to become visible when no action happened in this browser.
 */
export const STATIC_DATA_STALE_TIME = 6 * 60 * 60_000;
/**
 * Installed sources and extensions come from this app's own API, not a remote index, so
 * checking them is cheap. A short freshness window (plus a check when the window regains
 * focus) makes an install done elsewhere (the desktop app, another browser, the server's
 * automatic update) show up within a minute instead of after six hours. The saved copy
 * still renders instantly at startup while the check runs.
 */
export const LOCAL_STATIC_DATA_STALE_TIME = 60_000;
const FAILED_REFRESH_RETRY_MS = 5 * 60_000;

const CACHE_KEY = 'projekt-manga:startup-static-data:v1';
const CACHE_VERSION = 1;

const sourceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  lang: z.string(),
  base_url: z.string(),
  isNSFW: z.boolean(),
});

const repositoryWithListingSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string().nullable(),
  badge_label: z.string().nullable(),
  description: z.string().nullable(),
  website: z.string().nullable(),
  added_at: z.string(),
  last_fetched_at: z.string().nullable(),
  enabled: z.boolean(),
  sources: z.array(extensionListingEntrySchema),
  fetchError: z.string().nullable(),
});

const installedExtensionSchema = z.object({
  id: z.string(),
  repository_id: z.string(),
  source_key: z.string(),
  name: z.string(),
  lang: z.string(),
  base_url: z.string(),
  is_nsfw: z.boolean(),
  content_rating: z.string().nullable(),
  allowed_hosts: z.array(z.string()),
  version: z.string(),
  version_code: z.number().nullable(),
  entry_url: z.string(),
  description: z.string().nullable(),
  homepage: z.string().nullable(),
  icon_url: z.string().nullable(),
  source_code_hash: z.string(),
  installed_at: z.string(),
  updated_at: z.string(),
  enabled: z.boolean(),
});

const cachedEntrySchema = <T extends z.ZodType>(schema: T) =>
  z.object({
    data: schema,
    updatedAt: z.number().finite().nonnegative(),
  });

const cacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  sources: cachedEntrySchema(z.array(sourceSummarySchema)).optional(),
  repositories: cachedEntrySchema(z.array(repositoryWithListingSchema)).optional(),
  installedExtensions: cachedEntrySchema(z.array(installedExtensionSchema)).optional(),
});

type CacheEntry<T> = { data: T; updatedAt: number };
type StaticDataCache = z.infer<typeof cacheSchema>;

export const staticDataQueries = {
  sources: {
    queryKey: queryKeys.sources,
    queryFn: ({ signal }: { signal: AbortSignal }) => getSources(signal),
    staleTime: LOCAL_STATIC_DATA_STALE_TIME,
    refetchOnWindowFocus: true,
  },
  repositories: {
    queryKey: queryKeys.extensionRepositories,
    queryFn: ({ signal }: { signal: AbortSignal }) => listExtensionRepositories(signal),
    staleTime: STATIC_DATA_STALE_TIME,
  },
  installedExtensions: {
    queryKey: queryKeys.installedExtensions,
    queryFn: ({ signal }: { signal: AbortSignal }) => listInstalledExtensions(signal),
    staleTime: LOCAL_STATIC_DATA_STALE_TIME,
    refetchOnWindowFocus: true,
  },
};

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Private browsing or a locked-down desktop webview can disable storage. The cache is
    // an optimisation only; queries still fetch normally in that case.
    return null;
  }
}

function readCache(): StaticDataCache | null {
  const localStorage = storage();
  if (!localStorage) return null;

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = cacheSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // A corrupt cache must never prevent the reader opening. It is removed below when the
    // browser permits it, then the regular network query repopulates it.
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // Storage remains unavailable; there is no user-facing failure to report.
    }
  }
  return null;
}

function isFresh(entry: CacheEntry<unknown>): boolean {
  const age = Date.now() - entry.updatedAt;
  return age >= 0 && age <= STATIC_DATA_STALE_TIME;
}

function cachedQueryEntry<T>(client: QueryClient, queryKey: QueryKey): CacheEntry<T> | undefined {
  const state = client.getQueryState<T>(queryKey);
  if (state?.status !== 'success' || state.data === undefined || state.dataUpdatedAt <= 0)
    return undefined;
  return { data: state.data, updatedAt: state.dataUpdatedAt };
}

/** Restores only validated, still-fresh values before observers start their normal fetches. */
export function restoreStaticDataCache(client: QueryClient): void {
  const cached = readCache();
  if (!cached) return;

  if (cached.sources && isFresh(cached.sources)) {
    client.setQueryData(queryKeys.sources, cached.sources.data, {
      updatedAt: cached.sources.updatedAt,
    });
  }
  if (cached.repositories && isFresh(cached.repositories)) {
    client.setQueryData(queryKeys.extensionRepositories, cached.repositories.data, {
      updatedAt: cached.repositories.updatedAt,
    });
  }
  if (cached.installedExtensions && isFresh(cached.installedExtensions)) {
    client.setQueryData(queryKeys.installedExtensions, cached.installedExtensions.data, {
      updatedAt: cached.installedExtensions.updatedAt,
    });
  }
}

/** Writes successful static-query results without persisting any other account or reader data. */
export function persistStaticDataCache(client: QueryClient): void {
  const localStorage = storage();
  if (!localStorage) return;

  const prior = readCache();
  const next: StaticDataCache = {
    version: CACHE_VERSION,
    sources: cachedQueryEntry<SourceSummary[]>(client, queryKeys.sources) ?? prior?.sources,
    repositories:
      cachedQueryEntry<ExtensionRepositoryWithListing[]>(client, queryKeys.extensionRepositories) ??
      prior?.repositories,
    installedExtensions:
      cachedQueryEntry<InstalledExtension[]>(client, queryKeys.installedExtensions) ??
      prior?.installedExtensions,
  };

  if (!next.sources && !next.repositories && !next.installedExtensions) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // Quota and privacy-mode failures only disable this performance optimisation.
  }
}

/** An extension mutation makes every saved static answer potentially misleading. */
export function clearStaticDataCache(): void {
  const localStorage = storage();
  if (!localStorage) return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // The live React Query cache is still invalidated by the caller.
  }
}

export function isStaticDataQuery(queryKey: QueryKey): boolean {
  const key = queryKey[0];
  return (
    key === queryKeys.sources[0] ||
    key === queryKeys.extensionRepositories[0] ||
    key === queryKeys.installedExtensions[0]
  );
}

/**
 * Starts all data needed by Sources and Extensions immediately behind the boot intro.
 * `fetchQuery` uses a restored fresh result without making a request, and otherwise
 * deduplicates with whichever page subscribes to the same query.
 */
export function useWarmStartupStaticData(): boolean {
  const client = useQueryClient();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNextWarmup = (failed: boolean) => {
      if (failed) {
        timer = setTimeout(() => void warm(), FAILED_REFRESH_RETRY_MS);
        return;
      }
      const updatedAt = [
        client.getQueryState(queryKeys.sources)?.dataUpdatedAt,
        client.getQueryState(queryKeys.extensionRepositories)?.dataUpdatedAt,
        client.getQueryState(queryKeys.installedExtensions)?.dataUpdatedAt,
      ].filter((value): value is number => Boolean(value && value > 0));
      const nextAt = updatedAt.length > 0 ? Math.min(...updatedAt) + STATIC_DATA_STALE_TIME : 0;
      // Successful results remain fresh until their own timestamps expire.
      const delay = nextAt > 0 ? Math.max(1_000, nextAt - Date.now()) : STATIC_DATA_STALE_TIME;
      timer = setTimeout(() => void warm(), delay);
    };

    const warm = async () => {
      const outcomes = await Promise.allSettled([
        client.fetchQuery(staticDataQueries.sources),
        client.fetchQuery(staticDataQueries.repositories),
        client.fetchQuery(staticDataQueries.installedExtensions),
      ]);
      persistStaticDataCache(client);
      if (cancelled) return;
      setReady(true);
      scheduleNextWarmup(outcomes.some((outcome) => outcome.status === 'rejected'));
    };

    void warm();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client]);

  return ready;
}
