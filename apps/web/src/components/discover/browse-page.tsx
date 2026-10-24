'use client';

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { FilterValue } from '@projekt-manga/types';
import {
  useSources,
  useSourceBrowsePaged,
  useSourceFilters,
  useSourceCapabilities,
} from '@/lib/library-store';
import { toDisplaySource, type DisplaySource } from '@/lib/manga-data';
import { SourceResultCard } from '@/components/discover/popular-section';
import { readBrowseSnapshot, saveBrowseSnapshot, type BrowseSnapshot } from '@/lib/browse-state';
import { ApiError } from '@projekt-manga/api-client';
import { FilterPanel } from '@/components/discover/filter-panel';
import { countActiveFilters, type FilterValues } from '@/lib/filter-values';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ArrowLeft, Search, Filter, X, ChevronDown } from 'lucide-react';
import { MangaGrid } from '@/components/manga-grid';
import { MangaGridSkeleton } from '@/components/skeletons';
import { useInstalledExtensions } from '@/lib/extensions-store';
import { useContentPrivacy, isAdultSource } from './content-privacy';
import { sourceLanguageValues, useSourceDisplayLanguage } from '@/lib/source-display-language';

/** The sort filter, when a source exposes one (e.g. MangaDex's "sortBy" select). Sources
 * without it omit the sort row rather than faking options they can't honour. */
const SORT_FILTER_KEY = 'sortBy';

/**
 * Shared by the Popular and Latest discover pages — same cards, filters, paging, and
 * session-storage state restoration (scroll position, loaded rows, active filters).
 * Only the browsed category, heading/icons, and whether rank badges show differ, so
 * those are the only things the two page components (`discover/popular/client.tsx`,
 * `discover/latest/client.tsx`) pass in.
 */
export function DiscoverBrowsePage({
  browseKey,
  category,
  icon: Icon,
  emptyIcon: EmptyIcon,
  defaultTitle,
  showRankBadges = false,
}: {
  /** sessionStorage key for this page's browse-state snapshot — must be unique per page. */
  browseKey: string;
  /** The source-browse category to fetch (e.g. "popular", "latest"). */
  category: string;
  icon: ComponentType<{ className?: string }>;
  emptyIcon: ComponentType<{ className?: string }>;
  /** Heading shown when no source-driven sort is active. */
  defaultTitle: string;
  /** Numbers the first three unfiltered results — only meaningful for a ranking. */
  showRankBadges?: boolean;
}) {
  const { sources } = useSources();
  const { installed } = useInstalledExtensions();
  const [privacy] = useContentPrivacy();
  const displaySources: DisplaySource[] = sources
    .map(toDisplaySource)
    .filter(
      (source) =>
        !privacy.hideAdult ||
        !isAdultSource(
          installed.find((row) => row.source_key === source.id)?.content_rating,
          source.isNSFW,
        ),
    );
  const searchParams = useSearchParams();
  const requestedSource = searchParams.get('source');

  // Restored after mount, never during render: sessionStorage is unavailable on the
  // server, so reading it inline makes the first client render disagree with the SSR
  // HTML and React discards the restored state.
  const [usableRestore, setUsableRestore] = useState<BrowseSnapshot | null>(null);
  const [restoreChecked, setRestoreChecked] = useState(false);

  const [sourceId, setSourceId] = useState<string | null>(requestedSource);
  // Submitting starts a source-wide search. Scraping on each keystroke would flood the
  // extension, so typing alone leaves the current result set unchanged.
  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filterValues, setFilterValues] = useState<FilterValues>({});
  const [sortValue, setSortValue] = useState<string>('');
  const lastSourceId = useRef<string | null>(sourceId);

  useEffect(() => {
    const snapshot = readBrowseSnapshot(browseKey, category, requestedSource);
    // An explicit ?source= is a deliberate navigation and outranks a stale snapshot.
    if (snapshot && (!requestedSource || snapshot.sourceId === requestedSource)) {
      setUsableRestore(snapshot);
      lastSourceId.current = snapshot.sourceId;
      if (snapshot.sourceId) setSourceId(snapshot.sourceId);
      setFilterValues(snapshot.filterValues);
      setSortValue(snapshot.sortValue);
      setQuery(snapshot.query);
      setQueryDraft(snapshot.query);
    }
    setRestoreChecked(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseKey]);

  // App Router can retain this component while only the query string changes.
  useEffect(() => {
    if (restoreChecked && requestedSource) setSourceId(requestedSource);
  }, [requestedSource, restoreChecked]);

  useEffect(() => {
    if (displaySources.length === 0) return;
    if (sourceId && displaySources.some((s) => s.id === sourceId)) return;
    setSourceId(displaySources[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displaySources.map((s) => s.id).join(',')]);

  const active = displaySources.find((s) => s.id === sourceId);
  const {
    capabilities,
    loading: capabilitiesLoading,
    error: capabilitiesError,
    retry: retryCapabilities,
  } = useSourceCapabilities(active?.id ?? null);
  const supportsBrowse = capabilities && (category !== 'latest' || capabilities.latest);
  const [displayLanguage] = useSourceDisplayLanguage(active?.id ?? null);
  const {
    filters: availableFilters,
    error: filtersError,
    retry: retryFilters,
  } = useSourceFilters(capabilities?.filters ? (active?.id ?? null) : null);

  // A source's filter vocabulary — sort options included — doesn't carry to another.
  // Seeded with the source we intend to show, not `active?.id`: the source list arrives
  // asynchronously, so `active` is undefined on the first render and the null → first-source
  // transition would read as a source *switch* and wipe the filters just restored.
  useEffect(() => {
    const current = active?.id ?? null;
    if (current === null || lastSourceId.current === current) return;
    lastSourceId.current = current;
    setFilterValues({});
    setSortValue('');
  }, [active?.id]);

  const sortField = availableFilters.find((f) => f.value === SORT_FILTER_KEY);
  const sortOptions = (sortField?.options ?? []).filter((o) => o.value);

  // Sort is a filter as far as the source is concerned, but it gets its own row in the
  // UI, so it's merged in here rather than living in the filter panel's values.
  const language = capabilities?.languageFilter
    ? sourceLanguageValues(availableFilters, displayLanguage).language
    : undefined;
  const effectiveFilters = useMemo<Record<string, FilterValue>>(() => {
    const merged: Record<string, FilterValue> = {
      ...(language ? { language } : {}),
      ...filterValues,
    };
    if (sortValue) merged[SORT_FILTER_KEY] = sortValue;
    else delete merged[SORT_FILTER_KEY];
    return merged;
  }, [filterValues, sortValue, language]);

  const restorable =
    usableRestore &&
    active?.id === usableRestore.sourceId &&
    displayLanguage === (usableRestore.displayLanguage ?? 'all') &&
    sortValue === usableRestore.sortValue &&
    query === usableRestore.query &&
    JSON.stringify(filterValues) === JSON.stringify(usableRestore.filterValues)
      ? usableRestore
      : null;

  // Identity must be stable, or the hook's restore effect re-fires on every render.
  const restoreInitial = useMemo(
    () =>
      restorable
        ? {
            items: restorable.items,
            hasMore: restorable.hasMore,
            nextCursor: restorable.nextCursor,
          }
        : null,
    [restorable],
  );

  const {
    items,
    itemsQueryIdentity,
    loading,
    loadingMore,
    hasMore,
    nextCursor,
    loadMoreError,
    retryLoadMore,
    loadMore,
    error,
    retry,
  } = useSourceBrowsePaged(
    // Held back until the snapshot has been checked, so a default-state fetch can't start
    // and then be thrown away (or worse, win the race against the restore).
    restoreChecked &&
      capabilities &&
      (query ? capabilities.search : category !== 'latest' || capabilities.latest)
      ? (active?.id ?? null)
      : null,
    category,
    effectiveFilters,
    20,
    restoreInitial,
    query,
  );

  // Tracked continuously rather than read at unmount: the router scrolls back to the top
  // as part of navigating away, so by the time the cleanup runs window.scrollY is already
  // 0 and the saved position is useless.
  const lastScrollY = useRef(0);
  useEffect(() => {
    // Next scrolls the window to the top for the *next* page while this one is still
    // mounted, with the URL already changed. Recording that would save scrollY 0, so only
    // scrolls made while this page's own URL is showing count.
    const ownPath = window.location.pathname;
    const onScroll = () => {
      if (window.location.pathname !== ownPath) return;
      lastScrollY.current = window.scrollY;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Put the scroll position back once the restored rows exist. Applied on two successive
  // frames because row heights settle across a few frames (and Next's own scroll
  // restoration runs in there too) — a single rAF can land before the page is tall enough
  // to scroll that far, which silently clamps it back to the top.
  // Do not turn this into a longer retry loop: ongoing programmatic scrolls fight a
  // reader's wheel, touch, keyboard, or scrollbar movement once they resume browsing.
  const restoredScroll = useRef(false);
  useEffect(() => {
    if (!restorable || restoredScroll.current || items.length === 0) return;
    const target = restorable.scrollY;
    if (target <= 0) {
      restoredScroll.current = true;
      return;
    }
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      window.scrollTo(0, target);
      secondFrame = requestAnimationFrame(() => {
        window.scrollTo(0, target);
        restoredScroll.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [items.length, restorable]);

  // Serializing a long list on every items change is expensive, so the latest closure is
  // parked in a ref and only written when the page is left (unmount, pagehide, tab hidden).
  const writeSnapshot = useRef<() => void>(() => {});
  writeSnapshot.current = () => {
    // Never overwrite a good snapshot with an empty one: unmounting before results exist
    // would otherwise wipe the snapshot being restored.
    const currentIdentity = JSON.stringify([
      active?.id ?? null,
      category,
      JSON.stringify(effectiveFilters),
      query.trim(),
    ]);
    if (!restoreChecked || items.length === 0 || itemsQueryIdentity !== currentIdentity) return;
    saveBrowseSnapshot(browseKey, {
      displayLanguage,
      sourceId: active?.id ?? null,
      category,
      query,
      sortValue,
      filterValues,
      items,
      hasMore,
      nextCursor,
      scrollY: lastScrollY.current,
    });
  };
  useEffect(() => {
    const save = () => writeSnapshot.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save();
    };
    // Covers both in-app navigation (unmount) and a full page unload.
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
      save();
    };
  }, []);

  // Auto-load the next page as the sentinel nears the viewport; the button below stays
  // available for anyone who'd rather advance deliberately (or if the observer misses).
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading || loadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, loadMore]);

  const activeFilterCount = countActiveFilters(filterValues);
  const activeSortLabel = sortOptions.find((o) => o.value === sortValue)?.label;

  return (
    <div className="min-w-0 px-8 py-6">
      <header className="flex flex-col gap-5">
        <Link
          href="/discover"
          className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Discover
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              <Icon className="h-3 w-3 text-primary" /> Browse
            </div>
            {/* Reflects the chosen ranking rather than always claiming the default title. */}
            <h1 className="mt-1 truncate text-display text-4xl text-foreground">
              {query ? `Results for “${query}”` : (activeSortLabel ?? defaultTitle)}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {loading ? 'Loading…' : `${items.length}${hasMore ? '+' : ''} titles`}
              {active ? ` on ${active.name}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {capabilities?.search && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setQuery(queryDraft.trim());
                }}
                className="flex items-center gap-2 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-xs text-muted-foreground focus-within:border-primary/50"
              >
                <Search className="h-3.5 w-3.5" />
                <input
                  value={queryDraft}
                  onChange={(e) => setQueryDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && (queryDraft || query)) {
                      e.preventDefault();
                      setQueryDraft('');
                      setQuery('');
                    }
                  }}
                  aria-label="Search all titles on this source"
                  placeholder="Search this source…"
                  className="w-44 bg-transparent text-foreground outline-none placeholder:text-muted-foreground pointer-coarse:min-h-6"
                />
                {(queryDraft || query) && (
                  <button
                    type="button"
                    onClick={() => {
                      setQueryDraft('');
                      setQuery('');
                    }}
                    aria-label="Clear search"
                    className="hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                <button type="submit" className="font-medium text-primary hover:opacity-80">
                  Search
                </button>
              </form>
            )}
            {availableFilters.length > 0 && (
              <button
                onClick={() => setShowFilters((v) => !v)}
                aria-expanded={showFilters}
                className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition ${
                  showFilters || activeFilterCount
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/60 bg-surface/40 text-muted-foreground hover:text-foreground'
                }`}
              >
                <Filter className="h-3.5 w-3.5" /> Filters
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            )}
            {filtersError && (
              <button
                type="button"
                onClick={() => void retryFilters()}
                className="text-xs text-destructive hover:underline"
              >
                Filters unavailable · Retry
              </button>
            )}
            {displaySources.length > 1 && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger className="flex h-9 min-w-32 items-center justify-between gap-2 rounded-full border border-border/60 bg-surface/40 px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  {active?.name ?? 'Select source'}
                  <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {displaySources.map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      onSelect={() => setSourceId(s.id)}
                      className={`text-xs ${sourceId === s.id ? 'text-primary' : ''}`}
                    >
                      {s.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      {/* Source-driven ranking tabs — only rendered when the source actually supports
          sorting, so the control can never promise an ordering it won't apply. */}
      {sortOptions.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setSortValue('')}
            className={`rounded-full px-3 py-1.5 text-xs transition ${
              sortValue === ''
                ? 'bg-surface text-foreground ring-1 ring-primary/50'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Default
          </button>
          {sortOptions.map((o) => (
            <button
              key={o.value}
              onClick={() => setSortValue(o.value)}
              className={`rounded-full px-3 py-1.5 text-xs transition ${
                sortValue === o.value
                  ? 'bg-surface text-foreground ring-1 ring-primary/50'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {showFilters && (
        <FilterPanel
          fields={availableFilters.filter((f) => f.value !== SORT_FILTER_KEY)}
          values={filterValues}
          onApply={setFilterValues}
        />
      )}

      <section className="mt-8">
        {capabilitiesError && (
          <button
            type="button"
            onClick={() => void retryCapabilities()}
            className="text-xs text-destructive hover:underline"
          >
            Source options unavailable · Retry
          </button>
        )}
        {capabilities && !query && category === 'latest' && !capabilities.latest && (
          <p role="status" className="text-sm text-muted-foreground">
            This source does not support latest listings. Browse its popular titles instead.
          </p>
        )}
        {(loading || capabilitiesLoading) && items.length === 0 ? (
          <MangaGridSkeleton />
        ) : (
          // A restored visit mounts every card the reader had already scrolled through:
          // the grid otherwise reveals large lists in chunks, and a page only one chunk
          // tall can't scroll back down to where they were.
          <MangaGrid revealAtLeast={restorable ? restorable.items.length : 0}>
            {items.map((m, i) => (
              <div key={`${m.source}-${m.id}`} className="relative">
                {/* Rank badges only make sense on an unfiltered, unsearched ranking. */}
                {showRankBadges && i < 3 && !query && !sortValue && activeFilterCount === 0 && (
                  <span className="absolute -left-2 -top-2 z-10 grid h-6 w-6 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground shadow-glow">
                    #{i + 1}
                  </span>
                )}
                <SourceResultCard sourceId={m.source} item={m} />
              </div>
            ))}
          </MangaGrid>
        )}

        {/* A failed source is distinct from one with nothing to show: "no titles match"
            would wrongly send the reader to adjust filters. */}
        {!loading && error !== null && items.length === 0 && (
          <div className="mt-12 rounded-2xl border border-destructive/40 bg-destructive/5 p-8 text-center">
            <p className="text-sm font-medium text-foreground">Couldn&apos;t reach this source</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              {error instanceof ApiError
                ? error.message
                : 'Something went wrong loading titles from this source.'}
            </p>
            <button
              onClick={retry}
              className="mt-4 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
            >
              Try again
            </button>
          </div>
        )}

        {!loading &&
          !capabilitiesLoading &&
          !capabilitiesError &&
          supportsBrowse &&
          error === null &&
          items.length === 0 && (
            <div className="mt-12 rounded-2xl border border-border/60 bg-surface/40 p-8 text-center">
              <EmptyIcon className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {query
                  ? `No titles found for “${query}” on this source.`
                  : 'No titles match these filters.'}
              </p>
            </div>
          )}

        <div ref={sentinelRef} className="h-1" />

        {hasMore && (
          <div className="mt-10 flex justify-center">
            <button
              onClick={() => (loadMoreError ? retryLoadMore() : loadMore())}
              disabled={loadingMore}
              className="rounded-full border border-border/60 bg-surface/40 px-5 py-2 text-xs font-medium text-foreground transition hover:border-primary/50 hover:text-primary disabled:opacity-60"
            >
              {loadingMore
                ? 'Loading…'
                : loadMoreError
                  ? 'Could not load more · Retry'
                  : 'Load more'}
            </button>
          </div>
        )}

        {!hasMore && items.length > 0 && (
          <p className="mt-10 text-center text-xs text-muted-foreground">
            End of results — {items.length} titles.
          </p>
        )}
      </section>
    </div>
  );
}
