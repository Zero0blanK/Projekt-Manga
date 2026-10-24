'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { getChapterFetchDate, type RecentChapter } from '@projekt-manga/api-client';

/**
 * Newly fetched chapters, kept current without a page reload.
 *
 * The server has no push channel for library updates (the only SSE stream it exposes is
 * download progress), so this polls `GET /chapter/recent` on an interval. Two things keep
 * that cheap: polling is paused whenever the tab is hidden or nothing is subscribed, and
 * the library-update run calls `invalidateRecentChapters()` as it goes — so chapters
 * found by an update in this tab appear immediately rather than at the next tick.
 */
const POLL_INTERVAL_MS = 30_000;

let chapters: RecentChapter[] = [];
let loading = true;
let inFlight = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const emit = () => listeners.forEach((l) => l());

function load() {
  if (inFlight) return;
  inFlight = true;
  getChapterFetchDate()
    .then((next) => {
      chapters = next;
    })
    .catch(() => {
      /* a failed poll just leaves the previous list in place */
    })
    .finally(() => {
      inFlight = false;
      loading = false;
      emit();
    });
}

function startPolling() {
  if (timer !== null) return;
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/** Catches up straight away on returning to the tab, rather than after up to a full
 * interval of staleness. */
function onVisibilityChange() {
  if (document.visibilityState === 'visible') load();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    load();
    startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

const EMPTY: RecentChapter[] = [];

export function useRecentChapters() {
  const data = useSyncExternalStore(
    subscribe,
    () => chapters,
    () => EMPTY,
  );
  const isLoading = useSyncExternalStore(
    subscribe,
    () => loading,
    () => true,
  );
  return { chapters: data, loading: isLoading, refresh: load };
}

/** Re-reads the list now. Called by the library-update run so chapters it just pulled in
 * show up without waiting for the next poll. */
export function invalidateRecentChapters() {
  load();
}

/** Keeps the store polling for as long as the component is mounted, without reading it. */
export function useRecentChaptersConnection() {
  useEffect(() => subscribe(() => {}), []);
}

/* ------------------------------------------------------------------- grouping */

export type MangaUpdate = {
  mangaId: string;
  title: string;
  thumbnailUrl: string | null;
  /** Newest first. */
  chapters: RecentChapter[];
  /** The most recent `fetched_at` across the group — what the group is sorted and
   * bucketed by. */
  fetchedAt: string;
};

const timeOf = (c: RecentChapter) => (c.fetched_at ? +new Date(c.fetched_at) : 0);

/**
 * Collapses a flat chapter feed into one entry per manga.
 *
 * A source that publishes eight chapters at once would otherwise yield eight near-identical
 * rows for the same title; grouping keeps the title as the unit and moves the individual
 * chapters into a dropdown.
 */
export function groupChaptersByManga(items: RecentChapter[]): MangaUpdate[] {
  const byManga = new Map<string, MangaUpdate>();
  for (const chapter of items) {
    const existing = byManga.get(chapter.manga.id);
    if (existing) {
      existing.chapters.push(chapter);
    } else {
      byManga.set(chapter.manga.id, {
        mangaId: chapter.manga.id,
        title: chapter.manga.title,
        thumbnailUrl: chapter.manga.thumbnail_url || null,
        chapters: [chapter],
        fetchedAt: chapter.fetched_at ?? '',
      });
    }
  }
  const groups = [...byManga.values()];
  for (const group of groups) {
    group.chapters.sort((a, b) => b.chapter_number - a.chapter_number);
    group.fetchedAt = group.chapters.reduce(
      (latest, c) => (timeOf(c) > +new Date(latest || 0) ? (c.fetched_at ?? latest) : latest),
      group.fetchedAt,
    );
  }
  return groups.sort((a, b) => +new Date(b.fetchedAt || 0) - +new Date(a.fetchedAt || 0));
}

const DAY_MS = 24 * 3600_000;

/** Bucket label for a fetch timestamp — "Today", "Yesterday", or the date. */
export function fetchDayLabel(iso: string): string {
  if (!iso) return 'Unknown date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today.getTime() - DAY_MS);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

export type UpdateDay = { label: string; fetchedAt: string; updates: MangaUpdate[] };

/**
 * Groups per-manga updates into date buckets by `fetched_at` — when the update run
 * actually pulled the chapter in, which is what "new to me" means here. Chapter release
 * dates are a different thing entirely and can be years old on a first fetch.
 */
export function groupUpdatesByDay(updates: MangaUpdate[]): UpdateDay[] {
  const days = new Map<string, UpdateDay>();
  for (const update of updates) {
    const label = fetchDayLabel(update.fetchedAt);
    const day = days.get(label);
    if (day) day.updates.push(update);
    else days.set(label, { label, fetchedAt: update.fetchedAt, updates: [update] });
  }
  // `updates` arrives newest-first, so insertion order is already correct.
  return [...days.values()];
}
