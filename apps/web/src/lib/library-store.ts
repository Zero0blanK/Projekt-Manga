'use client';
import { mergeSourceResults } from './source-results';
import { appendSourcePage } from './source-pagination';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getManga,
  getLibraryState as apiGetLibraryState,
  updateLibraryState as apiUpdateLibraryState,
  getSources,
  getSourceMangaPage,
  searchSourceMangaPage,
  getSourceCapabilities,
  getSourceFilters,
  ApiError,
  type LibraryState as ApiLibraryState,
  type ShelfStatus as ApiShelfStatus,
  type SourceSummary,
  type UpdateLibraryStatePayload,
} from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import type { Mangas, MangaFilter, FilterValue } from '@projekt-manga/types';
import { fromMangaListItem, type Manga } from './manga-data';
import type { ShelfStatus } from './app-store';
import { queryClient, queryKeys } from './query-client';
import { reportError } from './report-error';
import { staticDataQueries } from './startup-static-data';

/* ------------------------------------------------------------- shared resources */

/**
 * Stable empty values. Returned while a query has no data yet, and shared rather than
 * rebuilt per render: a fresh `[]` is a new identity every time, which turns every
 * consumer's `useMemo`/dependency array into a guaranteed miss.
 */
const EMPTY_MANGA: Manga[] = [];
const EMPTY_LIBRARY_STATE: ApiLibraryState[] = [];
const EMPTY_SOURCES: SourceSummary[] = [];

/**
 * Hydration-safe read of a client-only query.
 *
 * Every query here runs in the browser, so the server renders with no data at all. The
 * first client render has to agree with that HTML even if the cache is already warm —
 * the root layout mounts first and starts fetching, and with streaming a deeper
 * component can hydrate after that resolves. Reporting the empty value until after the
 * first effect is what keeps the two renders identical.
 */
function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

export function useMangaLibrary() {
  const hydrated = useHydrated();
  const client = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: queryKeys.mangaLibrary,
    queryFn: async ({ signal }) => (await getManga({}, signal)).map(fromMangaListItem),
  });

  return {
    manga: hydrated ? (data ?? EMPTY_MANGA) : EMPTY_MANGA,
    loading: !hydrated || isPending,
    error,
    refresh: () => client.invalidateQueries({ queryKey: queryKeys.mangaLibrary }),
  };
}

export function useSources() {
  const hydrated = useHydrated();
  const { data, isPending, error } = useQuery({
    ...staticDataQueries.sources,
  });

  return {
    sources: hydrated ? (data ?? EMPTY_SOURCES) : EMPTY_SOURCES,
    loading: !hydrated || isPending,
    error,
  };
}

/**
 * Tells the reader a source failed, rather than leaving them looking at an empty grid.
 *
 * Swallowing source errors with `.catch(() => [])` would make an unreachable or broken
 * source indistinguishable from one that legitimately returned nothing, and the browse
 * page would blame the reader's filters for an outage. A cancelled request is not a
 * failure and is deliberately silent: navigating away or changing filters aborts the
 * previous request every time.
 */
export function reportSourceFailure(error: unknown, sourceLabel: string): void {
  // Prefixed with the source so a multi-source browse says *which* one failed; the
  // deduping and the abort check live in reportError, shared with every other screen.
  reportError(
    error,
    error instanceof ApiError
      ? `${sourceLabel}:`
      : `${sourceLabel}: Something went wrong reaching this source. Try again shortly.`,
  );
}

export type TaggedMangas = Mangas & { sourceName: string };

/** Browses one or more sources' catalogs in parallel for the given category (e.g.
 * "latest"/"popular") and merges the results, tagged with the owning source's name.
 * `filters` are only meaningful for a single source at a time — each source defines its
 * own filter vocabulary, so they're applied as-is to every id passed in. */
export function useSourceBrowse(
  sourceIds: string[],
  category: string,
  filters?: Record<string, FilterValue>,
) {
  const { sources } = useSources();

  const { data, isFetching, error } = useQuery({
    queryKey: queryKeys.sourceBrowse(sourceIds, category, filters ?? {}),
    enabled: sourceIds.length > 0,
    queryFn: async () => {
      // allSettled, not all: one unreachable source must not blank out the others'
      // results. Each failure is still reported.
      const outcomes = await Promise.allSettled(
        sourceIds.map((id) =>
          getSourceMangaPage(id, { category, filters }).then((page) => page.items),
        ),
      );

      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'rejected') {
          reportSourceFailure(outcome.reason, sourceIds[index]);
        }
      });

      const fulfilled = outcomes.filter(
        (o): o is PromiseFulfilledResult<Mangas[]> => o.status === 'fulfilled',
      );
      // Every source failed: reject so callers see an error state rather than an empty
      // grid that reads as "this source has nothing".
      if (fulfilled.length === 0 && outcomes.length > 0) {
        throw (outcomes[0] as PromiseRejectedResult).reason;
      }
      return fulfilled.flatMap((o) => o.value);
    },
  });

  // Tagging happens here rather than in queryFn so the cached rows don't go stale when
  // the source list finishes loading after the catalog does.
  const nameOf = (id: string) => sources.find((s) => s.id === id)?.name ?? id;
  const items: TaggedMangas[] = mergeSourceResults([], data ?? []).map((m) => ({
    ...m,
    sourceName: nameOf(m.source),
  }));

  return { items, loading: isFetching, error };
}

/**
 * Browses one source with opaque cursor pagination, accumulating results so the page can grow
 * on scroll or a "Load more" press. Resets whenever the source, category, or filters
 * change — those define a different result set, not more of the current one.
 */
export function useSourceBrowsePaged(
  sourceId: string | null,
  category: string,
  filters: Record<string, FilterValue>,
  pageSize = 20,
  /** Results carried over from a previous visit (see lib/browse-state). When present the
   * first fetch is skipped so returning from a preview keeps the pages already loaded. */
  initial?: { items: Mangas[]; hasMore: boolean; nextCursor?: string } | null,
  searchQuery = '',
) {
  const [items, setItems] = useState<Mangas[]>(initial?.items ?? []);
  const [itemsQueryIdentity, setItemsQueryIdentity] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initial?.hasMore ?? false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(initial?.nextCursor);
  const usedCursors = useRef(new Set<string>());
  const currentItems = useRef<Mangas[]>([]);
  const [loadMoreError, setLoadMoreError] = useState(false);
  /** The failure that emptied this page, if any — so the UI can say "this source is
   * unreachable" instead of "nothing matched". Cleared on every new query. */
  const [error, setError] = useState<unknown>(null);
  const filtersKey = JSON.stringify(filters ?? {});
  const query = searchQuery.trim();
  const queryIdentity = JSON.stringify([sourceId, category, filtersKey, query]);
  // Bumped on every reset so a slow in-flight page from a previous query can't append
  // its results into the new one.
  const requestId = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);
  // Consumed once: only the very first effect run may adopt restored results. Any later
  // source/filter/sort change is a genuinely different query and must re-fetch.
  const pendingRestore = useRef(initial ?? null);
  const hasLoadedOnce = useRef(false);
  /** Bumped by `retry()` purely to re-trigger the fetch effect for the same query. */
  const [retryToken, setRetryToken] = useState(0);

  // Restored results arrive after mount (sessionStorage can't be read during render
  // without a hydration mismatch), so accept them up until the first real load. Declared
  // above the fetch effect so it runs first within the same commit.
  useEffect(() => {
    if (initial && !hasLoadedOnce.current) pendingRestore.current = initial;
  }, [initial]);

  useEffect(() => {
    if (!sourceId) {
      // Invalidate a just-aborted request as well as clearing its UI state. Without this,
      // moving from a source to the source picker could let that abort handler overwrite
      // the clean empty state before its promise settles.
      requestId.current += 1;
      setItems([]);
      setItemsQueryIdentity(null);
      setHasMore(false);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      return;
    }
    if (pendingRestore.current) {
      const restored = pendingRestore.current;
      pendingRestore.current = null;
      if (restored.items.length > 0 && (!restored.hasMore || restored.nextCursor)) {
        hasLoadedOnce.current = true;
        currentItems.current = mergeSourceResults([], restored.items);
        setItems(currentItems.current);
        usedCursors.current = new Set();
        setItemsQueryIdentity(queryIdentity);
        setHasMore(restored.hasMore);
        setNextCursor(restored.nextCursor);
        setLoadMoreError(false);
        return;
      }
    }
    hasLoadedOnce.current = true;
    const id = ++requestId.current;
    const controller = new AbortController();
    setLoading(true);
    setItems([]);
    setItemsQueryIdentity(null);
    setHasMore(false);
    setNextCursor(undefined);
    usedCursors.current = new Set();
    currentItems.current = [];
    setLoadMoreError(false);
    setError(null);
    (query
      ? searchSourceMangaPage(sourceId, { query, filters, limit: pageSize }, controller.signal)
      : getSourceMangaPage(sourceId, { category, filters, limit: pageSize }, controller.signal)
    )
      .then((result) => {
        if (id !== requestId.current || controller.signal.aborted) return;
        currentItems.current = appendSourcePage([], result, usedCursors.current);
        setItems(currentItems.current);
        setItemsQueryIdentity(queryIdentity);
        setHasMore(result.hasMore);
        setNextCursor(result.nextCursor);
      })
      .catch((err) => {
        if (id !== requestId.current || controller.signal.aborted) return;
        setHasMore(false);
        // Surfaced so an empty grid isn't misread as "filters matched nothing".
        setError(err);
        reportSourceFailure(err, sourceId);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, category, filtersKey, pageSize, retryToken, query]);

  // A page for a prior source/filter combination is useless and may keep an extension
  // scraping after the reader has already moved on.
  useEffect(
    () => () => {
      loadMoreController.current?.abort();
      loadMoreController.current = null;
    },
    [sourceId, category, filtersKey, query],
  );

  const loadMore = useCallback(
    (force = false) => {
      if (
        !sourceId ||
        loading ||
        loadingMore ||
        loadMoreController.current ||
        !hasMore ||
        (loadMoreError && !force)
      )
        return;
      const id = requestId.current;
      const controller = new AbortController();
      loadMoreController.current = controller;
      setLoadingMore(true);
      (query
        ? searchSourceMangaPage(
            sourceId,
            { query, filters, limit: pageSize, cursor: nextCursor },
            controller.signal,
          )
        : getSourceMangaPage(
            sourceId,
            { category, filters, limit: pageSize, cursor: nextCursor },
            controller.signal,
          )
      )
        .then((result) => {
          if (id !== requestId.current || controller.signal.aborted) return;
          // Paging over a live catalog can hand back rows already shown, and a
          // duplicate key would break rendering — merge on id rather than concatenating.
          const cursors = new Set(usedCursors.current);
          if (nextCursor) cursors.add(nextCursor);
          const merged = appendSourcePage(currentItems.current, result, cursors);
          usedCursors.current = cursors;
          currentItems.current = merged;
          setItems(merged);
          setHasMore(result.hasMore);
          setNextCursor(result.nextCursor);
          setLoadMoreError(false);
        })
        .catch((err) => {
          if (id !== requestId.current || controller.signal.aborted) return;
          // Results already on screen stay; only the attempt to extend them failed, so this
          // reports without clearing anything or flipping the page into an error state.
          setLoadMoreError(true);
          reportSourceFailure(err, sourceId);
        })
        .finally(() => {
          if (loadMoreController.current === controller) loadMoreController.current = null;
          if (id === requestId.current) setLoadingMore(false);
        });
    },
    [
      sourceId,
      category,
      filters,
      query,
      nextCursor,
      hasMore,
      loadMoreError,
      loading,
      loadingMore,
      pageSize,
    ],
  );

  /** Re-runs the current query. Bound to the retry affordance on the browse page. */
  const retry = useCallback(() => {
    hasLoadedOnce.current = false;
    pendingRestore.current = null;
    setError(null);
    setRetryToken((n) => n + 1);
  }, []);

  return {
    items,
    itemsQueryIdentity,
    loading,
    loadingMore,
    hasMore,
    nextCursor,
    loadMoreError,
    retryLoadMore: () => loadMore(true),
    loadMore,
    error,
    retry,
  };
}

/** Stable empty list for `useSourceFilters` while nothing has loaded. Each source defines
 * its own filters (genre/status/sort/etc.); some have none. */
const EMPTY_FILTERS: MangaFilter[] = [];

export function useSourceCapabilities(sourceId: string | null) {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: queryKeys.sourceCapabilities(sourceId),
    enabled: sourceId !== null,
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) => getSourceCapabilities(sourceId!, signal),
    retry: 1,
  });
  return { capabilities: data, loading: sourceId !== null && isPending, error, retry: refetch };
}

export function useSourceFilters(sourceId: string | null) {
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.sourceFilters(sourceId),
    enabled: sourceId !== null,
    // A source's filter vocabulary is part of the extension, so it only changes when the
    // extension does.
    staleTime: 5 * 60_000,
    // Filters failing is not worth a toast of its own — the browse request alongside it
    // will have reported the same outage — but it must not retry endlessly either.
    queryFn: () => getSourceFilters(sourceId!),
    retry: 1,
  });

  return { filters: data ?? EMPTY_FILTERS, loading: isFetching, error, retry: refetch };
}

/* --------------------------------------------------------- library state (shelf/bookmarks) */

const SHELF_TO_API: Record<ShelfStatus, ApiShelfStatus> = {
  reading: 'READING',
  completed: 'COMPLETED',
  'on-hold': 'ON_HOLD',
  plan: 'PLAN',
  dropped: 'DROPPED',
};

const SHELF_FROM_API: Record<ApiShelfStatus, ShelfStatus> = {
  READING: 'reading',
  COMPLETED: 'completed',
  ON_HOLD: 'on-hold',
  PLAN: 'plan',
  DROPPED: 'dropped',
};

export function useLibraryState() {
  const hydrated = useHydrated();
  const query = useQuery({
    queryKey: queryKeys.libraryState,
    // Wrapped rather than passed bare: TanStack calls queryFn with a context object,
    // while these api-client functions take an optional AbortSignal as their first
    // argument — handing the context straight through would silently pass an object
    // where a signal was expected.
    queryFn: ({ signal }) => apiGetLibraryState(signal),
  });
  const data = hydrated ? (query.data ?? EMPTY_LIBRARY_STATE) : EMPTY_LIBRARY_STATE;
  const loading = !hydrated || query.isPending;
  const error = query.error;

  const bookmarks = data.filter((s) => s.is_bookmarked).map((s) => s.manga_id);
  const shelf: Record<string, ShelfStatus> = {};
  // Personal rating, 0-100 — absent entirely for anonymous usage (see LibraryState.score).
  const score: Record<string, number> = {};
  const readNotifications: string[] = [];
  for (const s of data) {
    if (s.shelf_status) shelf[s.manga_id] = SHELF_FROM_API[s.shelf_status];
    if (s.score != null) score[s.manga_id] = s.score;
    if (s.notification_read) readNotifications.push(s.manga_id);
  }

  return { bookmarks, shelf, score, readNotifications, loading, error };
}

/**
 * The library-state rows as the cache currently holds them.
 *
 * These helpers are called from `libraryActions`, which are plain functions invoked by
 * click handlers rather than hooks — reading the cache directly is how they stay usable
 * outside React while still driving the same data every component renders from.
 */
function currentLibraryState(): ApiLibraryState[] {
  return queryClient.getQueryData<ApiLibraryState[]>(queryKeys.libraryState) ?? EMPTY_LIBRARY_STATE;
}

function setLibraryState(next: ApiLibraryState[]) {
  queryClient.setQueryData(queryKeys.libraryState, next);
}

function patchLocal(mangaId: string, patch: Partial<ApiLibraryState>) {
  const current = currentLibraryState();
  const idx = current.findIndex((s) => s.manga_id === mangaId);
  const now = new Date().toISOString();
  if (idx === -1) {
    setLibraryState([
      ...current,
      {
        manga_id: mangaId,
        is_bookmarked: false,
        shelf_status: null,
        notification_read: false,
        created_at: now,
        updated_at: now,
        ...patch,
      },
    ]);
  } else {
    const next = [...current];
    next[idx] = { ...next[idx], ...patch, updated_at: now };
    setLibraryState(next);
  }
}

/** The row for one manga as it stands right now, or null when it has no row yet. */
function snapshotLocal(mangaId: string): ApiLibraryState | null {
  return currentLibraryState().find((s) => s.manga_id === mangaId) ?? null;
}

/** Puts one manga's row back exactly as `snapshotLocal` found it — including removing a
 * row that `patchLocal` had to invent. Scoped to the single manga rather than restoring a
 * whole-list snapshot, so rolling one failed action back can't discard a concurrent
 * action's optimistic update to a different title. */
function restoreLocal(mangaId: string, previous: ApiLibraryState | null) {
  const current = currentLibraryState();
  const idx = current.findIndex((s) => s.manga_id === mangaId);

  if (previous === null) {
    if (idx !== -1) setLibraryState(current.filter((s) => s.manga_id !== mangaId));
    return;
  }
  if (idx === -1) {
    setLibraryState([...current, previous]);
    return;
  }
  const next = [...current];
  next[idx] = previous;
  setLibraryState(next);
}

/**
 * Applies a library-state change locally first, then persists it.
 *
 * The optimistic patch has to be undone when the write fails, or the UI keeps showing a
 * bookmark/shelf/score the server never accepted — which then silently vanishes on the
 * next reload, looking like the app lost the change for no reason.
 *
 * Still rejects after rolling back: callers that await this (see source-action-bar) rely
 * on the rejection to avoid reporting success, and fire-and-forget callers should route
 * through `applyLibraryAction` so the failure is surfaced rather than becoming an
 * unhandled rejection.
 */
async function optimisticUpdate(mangaId: string, patch: UpdateLibraryStatePayload) {
  const owner = queryClient.getQueryData<{ id: string } | null>(queryKeys.session)?.id ?? null;
  const previous = snapshotLocal(mangaId);
  patchLocal(mangaId, patch);
  try {
    await apiUpdateLibraryState(mangaId, patch);
  } catch (error) {
    if ((queryClient.getQueryData<{ id: string } | null>(queryKeys.session)?.id ?? null) === owner)
      restoreLocal(mangaId, previous);
    throw error;
  }
}

export const libraryActions = {
  async setBookmark(mangaId: string, bookmarked: boolean) {
    await optimisticUpdate(mangaId, { is_bookmarked: bookmarked });
  },
  async toggleBookmark(mangaId: string) {
    const current = currentLibraryState().find((s) => s.manga_id === mangaId);
    const next = !(current?.is_bookmarked ?? false);
    await optimisticUpdate(mangaId, { is_bookmarked: next });
  },
  async setShelf(mangaId: string, status: ShelfStatus) {
    await optimisticUpdate(mangaId, { shelf_status: SHELF_TO_API[status] });
  },
  async removeShelf(mangaId: string) {
    await optimisticUpdate(mangaId, { shelf_status: null });
  },
  /** `score` is 0-100 (this app's fixed scale) — account-only, no-op-safe to call
   * without one since the server just ignores it on the anonymous path. */
  async setScore(mangaId: string, score: number) {
    await optimisticUpdate(mangaId, { score });
  },
  async markNotificationRead(mangaId: string) {
    await optimisticUpdate(mangaId, { notification_read: true });
  },
  async markNotificationUnread(mangaId: string) {
    await optimisticUpdate(mangaId, { notification_read: false });
  },
  /** Settles every id even if some fail, so one unreachable row can't strand the rest as
   * unread — `Promise.all` would reject at the first failure while the other writes were
   * still in flight. Rejects at the end if any of them failed. */
  async markAllNotificationsRead(mangaIds: string[]) {
    const results = await Promise.allSettled(
      mangaIds.map((id) => libraryActions.markNotificationRead(id)),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      throw new Error(`${failed} of ${mangaIds.length} titles could not be marked read`);
    }
  },
};

/**
 * Runs a library action that nothing awaits, reporting failure instead of dropping it.
 *
 * These are called from click handlers that have already shown an optimistic toast, so a
 * bare `void action()` would turn every server rejection into an unhandled promise
 * rejection and leave the reader believing a change had stuck. The action itself rolls the local
 * state back; this is what tells the reader it did.
 */
export function applyLibraryAction(action: Promise<unknown>, failureMessage: string) {
  action.catch(() => toast({ variant: 'destructive', description: failureMessage }));
}
