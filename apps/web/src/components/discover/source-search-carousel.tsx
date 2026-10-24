'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilterValue, Mangas } from '@projekt-manga/types';
import { searchSourceMangaPage } from '@projekt-manga/api-client';
import type { DisplaySource } from '@/lib/manga-data';
import { SourceResultCard } from '@/components/discover/popular-section';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useScrollBehavior } from '@/lib/scroll';
import { reportError } from '@/lib/report-error';
import { scheduleSourceSearch } from '@/lib/source-search-queue';
import { appendSourcePage } from '@/lib/source-pagination';
import { useSourceFilters, useSourceCapabilities } from '@/lib/library-store';
import { sourceLanguageValues, useSourceDisplayLanguage } from '@/lib/source-display-language';

/** One request's worth of results. Kept small because every page is a live scrape. */
const PAGE_SIZE = 10;
/** Fetch the next page once the reader reaches this many cards from the end — i.e. at
 * card 9 of 10, so the following batch is ready by the time they arrive at it. */
const PREFETCH_MARGIN = 1;

/**
 * Search results for a single extension, as a horizontally scrolling row. Each source
 * paginates independently: sources are separate sites with their own latency and result
 * counts, so one slow or exhausted extension never holds up the others.
 */
export function SourceSearchCarousel({ source, query }: { source: DisplaySource; query: string }) {
  const {
    capabilities,
    error: capabilitiesError,
    retry: retryCapabilities,
  } = useSourceCapabilities(source.id);
  const [displayLanguage] = useSourceDisplayLanguage(source.id);
  const { filters: sourceFilters } = useSourceFilters(
    capabilities?.languageFilter ? source.id : null,
  );
  const language = capabilities?.languageFilter
    ? sourceLanguageValues(sourceFilters, displayLanguage).language
    : undefined;
  const languageFilters = useMemo(() => {
    const filters: Record<string, FilterValue> = {};
    if (language) filters.language = language;
    return filters;
  }, [language]);
  const [items, setItems] = useState<Mangas[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const usedCursors = useRef(new Set<string>());
  const currentItems = useRef<Mangas[]>([]);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollBehavior = useScrollBehavior();
  // Guards against a slow response from a previous query appending into a newer one.
  const requestId = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    const id = ++requestId.current;
    const controller = new AbortController();
    setLoading(true);
    setLoadingMore(false);
    setItems([]);
    setHasMore(false);
    setNextCursor(undefined);
    currentItems.current = [];
    usedCursors.current = new Set();
    setLoadMoreError(false);
    setFailed(false);
    if (!capabilities?.search) {
      setLoading(!capabilities && !capabilitiesError);
      return () => controller.abort();
    }
    scheduleSourceSearch(controller.signal, () =>
      searchSourceMangaPage(
        source.id,
        { query, limit: PAGE_SIZE, filters: languageFilters },
        controller.signal,
      ),
    )
      .then((result) => {
        if (id !== requestId.current || controller.signal.aborted) return;
        currentItems.current = appendSourcePage([], result, usedCursors.current);
        setItems(currentItems.current);
        setHasMore(result.hasMore);
        setNextCursor(result.nextCursor);
      })
      .catch(() => {
        if (id === requestId.current && !controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
    return () => controller.abort();
  }, [source.id, query, retryToken, languageFilters, capabilities, capabilitiesError]);

  useEffect(
    () => () => {
      loadMoreController.current?.abort();
      loadMoreController.current = null;
    },
    [source.id, query, languageFilters, capabilities],
  );

  const loadMore = useCallback(
    (force = false) => {
      if (
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
      scheduleSourceSearch(controller.signal, () =>
        searchSourceMangaPage(
          source.id,
          {
            query,
            limit: PAGE_SIZE,
            cursor: nextCursor,
            filters: languageFilters,
          },
          controller.signal,
        ),
      )
        .then((result) => {
          if (id !== requestId.current || controller.signal.aborted) return;
          // Live catalogue pages can repeat rows; a duplicate key would break rendering.
          const cursors = new Set(usedCursors.current);
          if (nextCursor) cursors.add(nextCursor);
          const merged = appendSourcePage(currentItems.current, result, cursors);
          currentItems.current = merged;
          usedCursors.current = cursors;
          setItems(merged);
          setHasMore(result.hasMore);
          setNextCursor(result.nextCursor);
          setLoadMoreError(false);
        })
        .catch((error) => {
          if (id !== requestId.current || controller.signal.aborted) return;
          // Keep the results already shown, but do not hammer a source that just refused
          // this page; a new search can retry from a clean cursor.
          setLoadMoreError(true);
          reportError(error, `${source.name}: Couldn't load more results.`);
        })
        .finally(() => {
          if (loadMoreController.current === controller) loadMoreController.current = null;
          if (id === requestId.current) setLoadingMore(false);
        });
    },
    [
      source.id,
      source.name,
      query,
      nextCursor,
      hasMore,
      loadMoreError,
      loading,
      loadingMore,
      languageFilters,
    ],
  );

  // Watches how far along the row the reader has scrolled and pulls the next batch as
  // they approach the end, so paging forward never stalls on a fetch.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || items.length === 0) return;
    const cardWidth = el.scrollWidth / items.length;
    // A collapsed or not-yet-laid-out row measures 0 wide, which makes cardWidth 0 and
    // the index below Infinity — enough to trip the prefetch and pull a page nobody can
    // see yet. Wait until it has real geometry.
    if (!Number.isFinite(cardWidth) || cardWidth <= 0) return;
    const lastVisibleIndex = Math.ceil((el.scrollLeft + el.clientWidth) / cardWidth);
    if (lastVisibleIndex >= items.length - PREFETCH_MARGIN) loadMore();
  };

  const nudge = (direction: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: scrollBehavior });
  };

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[10px] font-bold text-white"
            style={{ background: `color-mix(in oklch, ${source.accent} 60%, black)` }}
          >
            {source.name.slice(0, 2).toUpperCase()}
          </span>
          <h2 className="text-lg font-semibold text-foreground">{source.name}</h2>
          <span className="text-xs text-muted-foreground">
            {loading ? 'searching…' : `${items.length}${hasMore ? '+' : ''} results`}
          </span>
        </div>
        {items.length > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => nudge(-1)}
              aria-label={`Scroll ${source.name} results left`}
              className="grid h-8 w-8 place-items-center rounded-full border border-border/60 text-muted-foreground transition hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => nudge(1)}
              aria-label={`Scroll ${source.name} results right`}
              className="grid h-8 w-8 place-items-center rounded-full border border-border/60 text-muted-foreground transition hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {capabilitiesError ? (
        <button
          type="button"
          onClick={() => void retryCapabilities()}
          className="mt-3 text-xs text-primary"
        >
          Source options unavailable · Retry
        </button>
      ) : capabilities && !capabilities.search ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          This source does not support searching.
        </p>
      ) : failed ? (
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <p>{source.name} couldn&apos;t be reached for this search.</p>
          <button
            type="button"
            onClick={() => setRetryToken((value) => value + 1)}
            className="font-medium text-primary hover:opacity-80"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {!loading && items.length === 0 && (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              No matches from {source.name}.
            </p>
          )}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="mt-4 flex gap-5 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {loading
              ? Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="w-36 shrink-0 animate-pulse">
                    <div className="aspect-2/3 w-full rounded-xl bg-muted" />
                    <div className="mt-2 h-3 w-3/4 rounded bg-muted" />
                  </div>
                ))
              : items.map((m) => (
                  <div key={`${m.source}-${m.id}`} className="w-36 shrink-0">
                    <SourceResultCard sourceId={source.id} item={m} />
                  </div>
                ))}
            {loadingMore && (
              <div className="w-36 shrink-0 animate-pulse">
                <div className="aspect-2/3 w-full rounded-xl bg-muted" />
              </div>
            )}
          </div>
          {loadMoreError && (
            <button
              type="button"
              onClick={() => loadMore(true)}
              className="mt-2 text-xs font-medium text-primary hover:underline"
            >
              Could not load more results · Retry
            </button>
          )}
        </>
      )}
    </section>
  );
}
