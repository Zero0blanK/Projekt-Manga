import type { HistoryEntry, LibraryState, MangaWithDetails } from '@projekt-manga/api-client';
import {
  addMangaBodySchema,
  addHistoryBodySchema,
  replaceBackupBodySchema,
} from '@projekt-manga/schemas';
import { z } from 'zod';

/**
 * A title as an export carries it. Unlike adding a title, a cover is not required: a title
 * restored from downloads whose source never gave one has an empty cover, and the server's
 * restore accepts it (replaceBackupBodySchema). Without this the reader's own export of such
 * a title could not be imported again.
 */
const exportedTitleSchema = addMangaBodySchema.extend({ thumbnail_url: z.string().max(2048) });

export type BackupPayload = {
  version: 2;
  manga: MangaWithDetails[];
  library: LibraryState[];
  history: HistoryEntry[];
  downloads?: unknown[];
  settings?: { settings?: Record<string, unknown>; profileOwner?: string } | null;
};

export type BackupMergePreview = {
  matchingTitles: number;
  addedTitles: number;
  skippedChapters: number;
  skippedLibraryStates: number;
  retainedHistory: number;
  addedHistory: number;
};

type HistoryIdentityFields = Pick<
  HistoryEntry,
  'source' | 'manga_slug' | 'chapter_id' | 'source_chapter_key'
>;

/** A history row's chapter, as the source names it. Exports written before history rows
 * carried `source_chapter_key` held that value in `chapter_id`. */
function historyIdentity(row: HistoryIdentityFields): string {
  return `${row.source}\0${row.manga_slug}\0${row.source_chapter_key ?? row.chapter_id ?? ''}`;
}

/** Estimates merge outcomes from the current library/history snapshots and import payload. */
export function previewBackupMerge(
  backup: BackupPayload,
  currentTitles: Array<Pick<MangaWithDetails, 'source' | 'slug'>>,
  currentHistory: HistoryIdentityFields[],
): BackupMergePreview {
  const currentTitleKeys = new Set(currentTitles.map((entry) => `${entry.source}\0${entry.slug}`));
  const matchingEntries = backup.manga.filter((entry) =>
    currentTitleKeys.has(`${entry.source}\0${entry.slug}`),
  );
  const matchingImportIds = new Set(matchingEntries.map((entry) => entry.id));
  const historyKeys = new Set(currentHistory.map(historyIdentity));
  let retainedHistory = 0;
  let addedHistory = 0;
  for (const row of backup.history) {
    if (historyKeys.has(historyIdentity(row))) retainedHistory++;
    else addedHistory++;
    historyKeys.add(historyIdentity(row));
  }
  return {
    matchingTitles: matchingEntries.length,
    addedTitles: backup.manga.length - matchingEntries.length,
    skippedChapters: matchingEntries.reduce((sum, entry) => sum + entry.chapters.length, 0),
    skippedLibraryStates: backup.library.filter((entry) => matchingImportIds.has(entry.manga_id))
      .length,
    retainedHistory,
    addedHistory,
  };
}

/** Validate every row before replace mode is allowed to remove existing data. */
export function parseBackup(value: unknown): BackupPayload {
  if (!value || typeof value !== 'object')
    throw new Error('This file is not a Projekt Manga export.');
  const backup = value as Partial<BackupPayload>;
  if (
    backup.version !== 2 ||
    !Array.isArray(backup.manga) ||
    !Array.isArray(backup.library) ||
    !Array.isArray(backup.history)
  ) {
    throw new Error(
      'This export is incomplete or from an unsupported version. Export it again before restoring.',
    );
  }
  if (
    backup.manga.length > 10_000 ||
    backup.library.length > 10_000 ||
    backup.history.length > 50_000
  ) {
    throw new Error('This export is too large to restore safely in one browser session.');
  }
  const mangaIds = new Set<string>();
  const mangaKeys = new Set<string>();
  for (const [index, entry] of backup.manga.entries()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !Array.isArray(entry.chapters) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      !exportedTitleSchema.safeParse({
        source: entry.source,
        title: entry.title,
        slug: entry.slug,
        author: entry.author,
        thumbnail_url: entry.thumbnail_url,
        artist: entry.artist ?? undefined,
        description: entry.description,
        genres: entry.genres,
        status: entry.status,
        rating: entry.rating ?? undefined,
        // Chapters use a different export contract: nullable scanlator/release-date/page
        // fields are valid there, so validate them with replaceBackupBodySchema below.
        chapters: [],
      }).success
    ) {
      throw new Error(
        `This export contains an invalid title or chapter in entry ${index + 1}. No data was changed.`,
      );
    }
    const mangaKey = `${entry.source}\0${entry.slug}`;
    if (mangaIds.has(entry.id) || mangaKeys.has(mangaKey)) {
      throw new Error(`This export contains a duplicate title in entry ${index + 1}.`);
    }
    mangaIds.add(entry.id);
    mangaKeys.add(mangaKey);
    // A source's chapter keys only name chapters within one title, so duplicates are
    // checked per title. Older exports carry only `id`, which held the same value.
    const chapterKeys = new Set<string>();
    for (const [chapterIndex, chapter] of entry.chapters.entries()) {
      const fields = chapter as { id?: unknown; source_chapter_key?: unknown } | null;
      const chapterKey = fields?.source_chapter_key ?? fields?.id;
      if (typeof chapterKey !== 'string') continue;
      if (chapterKeys.has(chapterKey)) {
        throw new Error(
          `This export contains a duplicate chapter in title ${index + 1}, chapter ${chapterIndex + 1}.`,
        );
      }
      chapterKeys.add(chapterKey);
    }
  }
  const libraryIds = new Set<string>();
  for (const [index, state] of backup.library.entries()) {
    if (
      !state ||
      typeof state !== 'object' ||
      typeof state.manga_id !== 'string' ||
      typeof state.is_bookmarked !== 'boolean' ||
      typeof state.notification_read !== 'boolean' ||
      (state.shelf_status !== null &&
        !['READING', 'COMPLETED', 'ON_HOLD', 'PLAN', 'DROPPED'].includes(state.shelf_status)) ||
      (state.score != null &&
        (!Number.isFinite(state.score) || state.score < 0 || state.score > 100))
    ) {
      throw new Error(
        `This export contains an invalid library state in entry ${index + 1}. No data was changed.`,
      );
    }
    if (libraryIds.has(state.manga_id)) {
      throw new Error(`This export contains a duplicate library state in entry ${index + 1}.`);
    }
    libraryIds.add(state.manga_id);
    if (!mangaIds.has(state.manga_id)) {
      throw new Error(
        `Library state entry ${index + 1} refers to a title that is not in this export.`,
      );
    }
  }
  for (const [index, entry] of backup.history.entries()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !addHistoryBodySchema.safeParse({
        source: entry.source,
        manga_id: entry.manga_id ?? undefined,
        manga_slug: entry.manga_slug,
        source_manga_id: entry.source_manga_id,
        source_chapter_key: entry.source_chapter_key ?? entry.chapter_id ?? undefined,
        title: entry.title,
        thumbnail_url: entry.thumbnail_url,
        pages_read: entry.pages_read,
        time_read: entry.time_read,
      }).success
    ) {
      throw new Error(
        `This export contains invalid reading history in entry ${index + 1}. No data was changed.`,
      );
    }
  }
  // Merge writes row by row, so reject malformed read-state and dangling library
  // references here too; otherwise a late failure leaves a partially imported backup.
  const restoreValidation = replaceBackupBodySchema.safeParse({
    jobId: '00000000-0000-4000-8000-000000000000',
    expectedUserId: null,
    version: backup.version,
    manga: backup.manga,
    library: backup.library,
    history: backup.history,
  });
  if (!restoreValidation.success) {
    const issue = restoreValidation.error.issues[0];
    const [section, row, nested, nestedRow] = issue?.path ?? [];
    if (section === 'manga' && typeof row === 'number' && nested === 'chapters') {
      const chapter = typeof nestedRow === 'number' ? `, chapter ${nestedRow + 1}` : '';
      throw new Error(
        `This export contains invalid chapter data in title ${row + 1}${chapter}. No data was changed.`,
      );
    }
    throw new Error(
      `This export has inconsistent chapter, library, or history data${issue?.path.length ? ` near ${issue.path.join('.')}` : ''}. No data was changed.`,
    );
  }
  return backup as BackupPayload;
}
