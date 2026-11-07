'use client';

import {
  getConnectedTrackers,
  getManga,
  linkMangaToTracker,
  markChapterByLastPage,
  markPreviousChaptersAsRead,
  type MangaChapterRecord,
} from '@projekt-manga/api-client';
import { actions } from '@/lib/app-store';
import { bulkPayload } from '@/lib/chapter-gaps';
import type { ChapterNumberState, MihonImportExtras } from './payload';

/**
 * What a Mihon import adds after its restore job succeeds. The restore payload has no
 * room for categories (kept in this browser's app state), tracker links (their own
 * endpoint) or read state matched by chapter number, so they wait here, tied to the job.
 */
const extrasKey = 'projekt-manga-mihon-import';
/** Per-title read state still waiting for the title's first chapter sync. */
const chapterStateKey = 'projekt-manga-mihon-chapter-state';

interface PendingExtras extends MihonImportExtras {
  jobId: string;
  owner: string;
}

const read = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const write = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the extras are a convenience, the restore itself stands.
  }
};

export function saveMihonImportExtras(jobId: string, owner: string, extras: MihonImportExtras) {
  write(extrasKey, { jobId, owner, ...extras } satisfies PendingExtras);
}

export function clearMihonImportExtras(jobId: string) {
  if (read<PendingExtras>(extrasKey)?.jobId === jobId) write(extrasKey, null);
}

type ChapterStateStore = Record<string, ChapterNumberState & { owner: string }>;
const stateId = (owner: string, source: string, slug: string) => `${owner}\0${source}\0${slug}`;

export interface AppliedExtras {
  categories: number;
  trackerLinks: number;
  /** Links for trackers this account has not connected. */
  skippedTrackerLinks: number;
}

/**
 * Applies a finished import's extras. Called once its restore job has succeeded and the
 * library has refreshed; does nothing for any other job. Each step is best-effort: a
 * tracker that refuses one link does not undo the categories.
 */
export async function applyMihonImportExtras(
  jobId: string,
  owner: string,
): Promise<AppliedExtras | null> {
  const pending = read<PendingExtras>(extrasKey);
  if (!pending || pending.jobId !== jobId || pending.owner !== owner) return null;
  write(extrasKey, null);

  const library = await getManga().catch(() => []);
  const idOf = new Map(library.map((title) => [`${title.source}\0${title.slug}`, title.id]));
  const applied: AppliedExtras = { categories: 0, trackerLinks: 0, skippedTrackerLinks: 0 };

  const members = pending.categories
    .map(({ name, titles }) => ({
      name,
      ids: titles.flatMap(({ source, slug }) => idOf.get(`${source}\0${slug}`) ?? []),
    }))
    .filter(({ ids }) => ids.length > 0);
  if (members.length > 0) {
    actions.mergeCategories(members);
    applied.categories = members.length;
  }

  if (pending.trackers.length > 0) {
    const connected = new Set(
      (await getConnectedTrackers().catch(() => [])).map((tracker) => tracker.tracker),
    );
    for (const link of pending.trackers) {
      const mangaId = idOf.get(`${link.source}\0${link.slug}`);
      if (!mangaId || !connected.has(link.tracker)) {
        applied.skippedTrackerLinks += 1;
        continue;
      }
      await linkMangaToTracker(mangaId, {
        tracker: link.tracker,
        tracker_media_id: link.tracker_media_id,
      }).then(
        () => (applied.trackerLinks += 1),
        () => (applied.skippedTrackerLinks += 1),
      );
    }
  }

  if (pending.chapterNumbers.length > 0) {
    const store = read<ChapterStateStore>(chapterStateKey) ?? {};
    for (const state of pending.chapterNumbers)
      store[stateId(owner, state.source, state.slug)] = { ...state, owner };
    write(chapterStateKey, store);
  }
  return applied;
}

/**
 * Applies read state saved by number for this title, once its chapters have been synced
 * (the list is not empty). Returns the rows with the marks applied, or null when there was
 * nothing to do. The saved state is dropped either way so it is only ever applied once.
 */
export async function applyMihonChapterState(
  owner: string,
  manga: { id: string; slug: string; source: string },
  rows: MangaChapterRecord[],
): Promise<MangaChapterRecord[] | null> {
  if (rows.length === 0) return null;
  const store = read<ChapterStateStore>(chapterStateKey);
  const id = stateId(owner, manga.source, manga.slug);
  const state = store?.[id];
  if (!store || !state) return null;
  delete store[id];
  write(chapterStateKey, Object.keys(store).length > 0 ? store : null);

  const readNumbers = new Set(state.read);
  const pages = new Map(state.lastPage);
  const toRead = rows.filter((row) => !row.is_read && readNumbers.has(row.chapter_number));
  if (toRead.length > 0)
    await markPreviousChaptersAsRead(
      manga.slug,
      toRead.map((row) => bulkPayload(row, manga.source)),
      { manga_id: manga.id },
    );
  const partial = rows.filter(
    (row) => !row.is_read && !readNumbers.has(row.chapter_number) && pages.has(row.chapter_number),
  );
  for (const row of partial)
    await markChapterByLastPage(
      manga.slug,
      row.source_chapter_key,
      pages.get(row.chapter_number)!,
      { ...bulkPayload(row, manga.source), source: manga.source },
    ).catch(() => undefined);

  const readIds = new Set(toRead.map((row) => row.id));
  return rows.map((row) =>
    readIds.has(row.id)
      ? { ...row, is_read: true }
      : pages.has(row.chapter_number) && !row.is_read
        ? { ...row, last_page_read: pages.get(row.chapter_number)! }
        : row,
  );
}
