'use client';

import { createElement, useSyncExternalStore } from 'react';
import {
  getMangaDetailsById,
  getSourceMangaDetails,
  searchSourceMangaPage,
  type PublicUser,
} from '@projekt-manga/api-client';
import type { Mangas } from '@projekt-manga/types';
import type { Manga } from './manga-data';
import type { ShelfStatus } from './app-store';
import { queryClient, queryKeys } from './query-client';
import { scheduleSourceSearch } from './source-search-queue';
import { migrationReadTargets, type MigrationOptions } from './migration-state';
import { findInSourceOrder, type FoundTitle } from './title-match';
import { migrateTitle, newMigrationCheckpoint, type MigrationCheckpoint } from './migrate-title';
import { toast } from '@/hooks/use-toast';
import { BulkMigrationProgress } from '@/components/migrate/bulk-migration-progress';

export type BulkRun =
  | { state: 'idle' }
  | { state: 'running'; label: string }
  | { state: 'done'; targetId: string }
  | { state: 'partial'; failed: number }
  | { state: 'failed'; message: string };

export interface BulkRow {
  manga: Manga;
  search: 'waiting' | 'searching' | 'found' | 'missing';
  /** Where the title will move: found by the search, or chosen by hand. */
  match: FoundTitle | null;
  /** Chosen by hand rather than found. */
  manual: boolean;
  /** Left out by the reader; kept in the list so it can be brought back. */
  skipped: boolean;
  run: BulkRun;
}

export type BulkStage = 'choose' | 'targets' | 'matches' | 'running' | 'finished';

export interface BulkMigrationState {
  /** The account the work belongs to; another account starts over. */
  owner: string;
  stage: BulkStage;
  from: string;
  /** Null until the reader changes it: the page then starts from the migration order. */
  order: string[] | null;
  options: MigrationOptions | null;
  rows: BulkRow[];
}

/** What a run needs from the library, read when it starts. */
export interface LibrarySnapshot {
  library: Manga[];
  shelf: Record<string, ShelfStatus>;
  bookmarks: string[];
  refresh: () => void;
}

const initial = (owner: string): BulkMigrationState => ({
  owner,
  stage: 'choose',
  from: '',
  order: null,
  options: null,
  rows: [],
});

// Module state outlives the page, so leaving /migrate neither stops nor forgets the work.
let state = initial('anonymous');
let restored = false;
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
const checkpoints = new Map<string, MigrationCheckpoint>();
let progressToast: ReturnType<typeof toast> | null = null;

const storageKey = (owner: string) => `bulk-migration:${encodeURIComponent(owner)}`;

/** Saved per tab, so a reload or a restart of the window keeps the matches. */
function save() {
  try {
    sessionStorage.setItem(storageKey(state.owner), JSON.stringify(state));
  } catch {
    // Storage full or blocked: the work still lives in memory.
  }
}

/** The saved work for `owner`. Work that was under way when the page went away stopped
 * with it: unfinished searches count as not found, and a run as stopped. */
function restore(owner: string): BulkMigrationState {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(storageKey(owner)) ?? 'null',
    ) as BulkMigrationState | null;
    if (!saved || saved.owner !== owner || !Array.isArray(saved.rows)) return initial(owner);
    const rows = saved.rows.map((row): BulkRow => ({
      ...row,
      search: row.search === 'waiting' || row.search === 'searching' ? 'missing' : row.search,
      run: row.run.state === 'running' ? { state: 'idle' } : row.run,
    }));
    return { ...saved, rows, stage: saved.stage === 'running' ? 'finished' : saved.stage };
  } catch {
    return initial(owner);
  }
}

const sessionOwner = () =>
  queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous';

function set(next: Partial<BulkMigrationState>) {
  state = { ...state, ...next };
  save();
  for (const listener of listeners) listener();
  showProgress();
}
const updateRow = (id: string, change: Partial<BulkRow>) =>
  set({ rows: state.rows.map((row) => (row.manga.id === id ? { ...row, ...change } : row)) });

/** Rows that will migrate. */
export const isIncluded = (row: BulkRow) => !!row.match && !row.skipped;

export function bulkProgress(current: BulkMigrationState = state) {
  if (current.stage === 'matches') {
    const total = current.rows.length;
    const done = current.rows.filter(
      (row) => row.search === 'found' || row.search === 'missing',
    ).length;
    return { kind: 'search' as const, done, total, active: done < total };
  }
  const queued = current.rows.filter(isIncluded);
  const done = queued.filter(
    (row) => row.run.state !== 'idle' && row.run.state !== 'running',
  ).length;
  return {
    kind: 'migrate' as const,
    done,
    total: queued.length,
    active: current.stage === 'running',
  };
}

/** A toast with a progress bar while titles are searched or migrated, on any page. */
function showProgress() {
  const progress = bulkProgress();
  if (!progress.active || !progress.total) {
    progressToast?.dismiss();
    progressToast = null;
    return;
  }
  const props = {
    title: progress.kind === 'search' ? 'Finding matches' : 'Migrating titles',
    description: createElement(BulkMigrationProgress, {
      done: progress.done,
      total: progress.total,
    }),
    duration: Infinity,
  };
  if (progressToast) progressToast.update({ ...props, id: progressToast.id });
  else progressToast = toast(props);
}

function ownState() {
  const owner = sessionOwner();
  if (!restored || state.owner !== owner) {
    if (restored) controller?.abort();
    restored = true;
    checkpoints.clear();
    state = typeof window === 'undefined' ? initial(owner) : restore(owner);
  }
  return state;
}

export function useBulkMigration(): BulkMigrationState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ownState,
    () => state,
  );
}

const searchSource = (signal: AbortSignal) => {
  const cache = new Map<string, Promise<Mangas[] | null>>();
  return (sourceId: string, query: string) => {
    const key = `${sourceId}\0${query}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = scheduleSourceSearch(signal, () =>
        searchSourceMangaPage(sourceId, { query, limit: 20 }, signal),
      ).then(
        (page) => page.items,
        () => {
          signal.throwIfAborted();
          return null;
        },
      );
      cache.set(key, pending);
    }
    return pending;
  };
};

export const bulkMigration = {
  /** Picks the source to move titles from and goes on to choosing where to. */
  chooseSource(from: string) {
    ownState();
    set({ from, stage: 'targets' });
  },
  setOrder(order: string[]) {
    set({ order });
  },
  setOptions(options: MigrationOptions) {
    set({ options });
  },
  backToSources() {
    controller?.abort();
    set({ stage: 'choose', rows: [] });
  },
  backToTargets() {
    controller?.abort();
    set({ stage: 'targets' });
  },
  /** Searches every library title of the chosen source in `order`. */
  async findMatches(titles: Manga[], order: string[]) {
    controller?.abort();
    checkpoints.clear();
    const search = new AbortController();
    controller = search;
    set({
      stage: 'matches',
      rows: titles.map((manga) => ({
        manga,
        search: 'waiting',
        match: null,
        manual: false,
        skipped: false,
        run: { state: 'idle' },
      })),
    });
    const lookup = searchSource(search.signal);
    await Promise.all(
      titles.map(async (manga) => {
        try {
          const match = await findInSourceOrder(
            manga.title,
            order,
            (id, query) => {
              if (!search.signal.aborted) updateRow(manga.id, { search: 'searching' });
              return lookup(id, query);
            },
            search.signal,
          );
          if (search.signal.aborted) return;
          updateRow(manga.id, { search: match ? 'found' : 'missing', match });
        } catch {
          // Aborted: the reader went back or started over.
        }
      }),
    );
  },
  /** Uses a title the reader picked by hand. */
  chooseMatch(id: string, match: FoundTitle) {
    updateRow(id, { match, manual: true, skipped: false });
  },
  setSkipped(id: string, skipped: boolean) {
    updateRow(id, { skipped });
  },
  stop() {
    controller?.abort();
  },
  /** Migrates every included title not yet done, one at a time. */
  async migrate(options: MigrationOptions, snapshot: LibrarySnapshot) {
    controller?.abort();
    const run = new AbortController();
    controller = run;
    const owner = state.owner;
    const current = () => !run.signal.aborted && sessionOwner() === owner;
    const queue = state.rows.filter((row) => isIncluded(row) && row.run.state !== 'done');
    // Reset what a previous run left, so the progress counts only this run's titles.
    for (const row of queue) updateRow(row.manga.id, { run: { state: 'idle' } });
    set({ stage: 'running' });
    // One at a time: each migration writes several rows and the original's categories.
    for (const { manga } of queue) {
      if (!current()) break;
      const match = state.rows.find((row) => row.manga.id === manga.id)?.match;
      if (!match) continue;
      const checkpoint = checkpoints.get(manga.id) ?? newMigrationCheckpoint();
      checkpoints.set(manga.id, checkpoint);
      updateRow(manga.id, { run: { state: 'running', label: 'Loading chapters…' } });
      try {
        const [details, original] = await Promise.all([
          getSourceMangaDetails(match.sourceId, match.slug),
          options.read ? getMangaDetailsById(manga.id) : null,
        ]);
        if (!current()) {
          updateRow(manga.id, { run: { state: 'idle' } });
          break;
        }
        const result = await migrateTitle({
          originalId: manga.id,
          sourceId: match.sourceId,
          details,
          readTargets: original
            ? migrationReadTargets(original.chapters, details.chapters)
            : new Set<string>(),
          options,
          library: snapshot.library,
          shelf: snapshot.shelf,
          bookmarks: snapshot.bookmarks,
          checkpoint,
          current,
          onProgress: (label) => updateRow(manga.id, { run: { state: 'running', label } }),
        });
        updateRow(manga.id, {
          run:
            result.state === 'stopped'
              ? { state: 'idle' }
              : result.state === 'partial'
                ? { state: 'partial', failed: result.failed.length }
                : { state: 'done', targetId: result.targetId },
        });
      } catch (error) {
        updateRow(manga.id, {
          run: {
            state: 'failed',
            message: error instanceof Error && error.message ? error.message : 'Migration failed.',
          },
        });
      }
    }
    snapshot.refresh();
    if (state.owner !== owner) return;
    set({ stage: 'finished' });
    const migrated = state.rows.filter((row) => row.run.state === 'done').length;
    const left = state.rows.filter((row) => isIncluded(row) && row.run.state !== 'done').length;
    toast({
      description: left
        ? `Migrated ${migrated} title${migrated === 1 ? '' : 's'}; ${left} not yet. Open Migrate a source to finish.`
        : `Migrated ${migrated} title${migrated === 1 ? '' : 's'}.`,
    });
  },
  /** Clears finished work so a new source can be migrated. */
  reset() {
    controller?.abort();
    checkpoints.clear();
    set(initial(state.owner));
  },
};
