'use client';

import { cancelDownload, getAllDownloads, markChapterAsRead } from '@projekt-manga/api-client';
import type { MangaDetails } from '@projekt-manga/types';
import type { Manga } from './manga-data';
import { libraryActions, setTitleInLibrary } from './library-store';
import type { ShelfStatus } from './app-store';
import { addSourceMangaToLibrary } from './discover-actions';
import { actions, getAppState } from './app-store';
import type { MigrationOptions } from './migration-state';
import { refreshDownloads } from '@/components/downloads/row-data';

/** What a migration has already done, so a retry picks up where it stopped. */
export interface MigrationCheckpoint {
  targetId: string | null;
  membership: boolean;
  shelf: boolean;
  bookmark: boolean;
  categories: boolean;
  downloads: boolean;
  removed: boolean;
  read: Set<string>;
}

export const newMigrationCheckpoint = (): MigrationCheckpoint => ({
  targetId: null,
  membership: false,
  shelf: false,
  bookmark: false,
  categories: false,
  downloads: false,
  removed: false,
  read: new Set<string>(),
});

export interface TitleMigration {
  /** The library entry being replaced. */
  originalId: string;
  /** The replacement, as its source describes it. */
  sourceId: string;
  details: MangaDetails;
  /** Replacement chapter ids to mark read (see `migrationReadTargets`). */
  readTargets: ReadonlySet<string>;
  options: MigrationOptions;
  library: Manga[];
  shelf: Record<string, ShelfStatus>;
  bookmarks: string[];
  checkpoint: MigrationCheckpoint;
  /** False once the migration should stop (another account signed in, the page left). */
  current: () => boolean;
  onProgress?: (label: string) => void;
}

export type TitleMigrationResult =
  | { state: 'stopped' }
  | { state: 'partial'; targetId: string; failed: string[] }
  | { state: 'done'; targetId: string };

/**
 * Moves one library title to a replacement on another source: adds the replacement to
 * the library, carries over the chosen state, then removes the original's downloads and
 * the original from the library. Steps already in the checkpoint are skipped, so calling
 * it again after a failure finishes the job. Request failures other than single chapter
 * transfers are thrown.
 */
export async function migrateTitle(job: TitleMigration): Promise<TitleMigrationResult> {
  const { checkpoint: done, details, sourceId, originalId, current } = job;
  job.onProgress?.('Preparing replacement…');
  const existing = job.library.find(
    (entry) =>
      entry.source === sourceId && (entry.slug === details.slug || entry.slug === details.id),
  );
  const id =
    done.targetId ??
    existing?.id ??
    (await addSourceMangaToLibrary(sourceId, details, details, false));
  if (!current()) return { state: 'stopped' };
  done.targetId = id;
  if (!done.membership) {
    await setTitleInLibrary(id, true, { refresh: false });
    if (!current()) return { state: 'stopped' };
    done.membership = true;
  }
  job.onProgress?.('Transferring library settings…');
  if (!done.shelf && job.options.shelf && job.shelf[originalId]) {
    await libraryActions.setShelf(id, job.shelf[originalId]);
    if (!current()) return { state: 'stopped' };
    done.shelf = true;
  }
  if (!done.bookmark && job.options.bookmark && job.bookmarks.includes(originalId)) {
    await libraryActions.setBookmark(id, true);
    if (!current()) return { state: 'stopped' };
    done.bookmark = true;
  }
  const failed: string[] = [];
  const pending = details.chapters.filter(
    (chapter) => job.readTargets.has(chapter.id) && !done.read.has(chapter.id),
  );
  for (const [index, replacement] of pending.entries()) {
    if (!current()) return { state: 'stopped' };
    job.onProgress?.(`Transferring progress ${index + 1} of ${pending.length}…`);
    try {
      await markChapterAsRead(details.slug || details.id, replacement.id, {
        ...replacement,
        source: sourceId,
      });
      if (!current()) return { state: 'stopped' };
      done.read.add(replacement.id);
    } catch {
      if (!current()) return { state: 'stopped' };
      failed.push(replacement.id);
    }
  }
  if (!current()) return { state: 'stopped' };
  if (!done.categories && job.options.categories) {
    for (const [category, members] of Object.entries(getAppState().categoryMembers))
      if (members.includes(originalId) && !members.includes(id))
        actions.toggleCategoryMember(category, id);
    done.categories = true;
  }
  // The original stays in the library until every chapter transferred.
  if (failed.length) return { state: 'partial', targetId: id, failed };
  if (!done.downloads) {
    job.onProgress?.('Removing original downloads…');
    const downloads = await getAllDownloads();
    if (!current()) return { state: 'stopped' };
    for (const download of downloads.filter((entry) => entry.manga_id === originalId)) {
      if (!current()) return { state: 'stopped' };
      await cancelDownload(download.id);
      if (!current()) return { state: 'stopped' };
    }
    done.downloads = true;
    refreshDownloads();
  }
  if (!current()) return { state: 'stopped' };
  if (!done.removed) {
    job.onProgress?.('Removing original from library…');
    await setTitleInLibrary(originalId, false, { refresh: false });
    if (!current()) return { state: 'stopped' };
    done.removed = true;
  }
  return { state: 'done', targetId: id };
}
