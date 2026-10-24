import prisma from '../configs/prisma.config.js';
import { withBusyRetry } from '../utils/sqliteRetry.js';
import { MangaNotFoundError, ValidationError } from '../utils/customErrors.js';
import { excludeExisting } from '../utils/skipDuplicates.js';

/**
 * Moves a library entry's reading state onto another entry — switching a series to a
 * different source without losing what you'd built up on the old one.
 *
 * **Atomic.** Everything below runs inside one `$transaction`, so a migration either
 * lands completely or not at all.
 *
 * An optional trailing `user_id` selects the path: an account's state lives in the `user_*`
 * overlay tables, while the anonymous path reads and writes the shared tables.
 *
 * Chapters are matched by **number, not id**. Two sources never share chapter ids, but
 * they do agree on "chapter 47", so progress transfers as "everything up to the furthest
 * chapter you had read" — the same monotonic rule the tracker sync uses.
 */

export interface MigrationOptions {
  removeOld: boolean;
  moveHistory: boolean;
}

export interface MigrationSummary {
  /** Furthest chapter number read on the old entry; 0 if nothing was read. */
  progress: number;
  chapters_marked: number;
  categories_moved: number;
  history_moved: number;
  state_copied: boolean;
  old_entry_removed: boolean;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Chapter ids on `to_manga_id` that fall at or below `progress`. Empty when nothing was
 * read, which is the common case for a title added and migrated straight away. */
async function chaptersUpTo(tx: Tx, manga_id: string, progress: number): Promise<string[]> {
  if (progress <= 0) {
    return [];
  }
  const rows = await tx.chapter.findMany({
    where: { manga_id, chapter_number: { lte: progress } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** The anonymous half: reading state lives on the shared `chapter`/`manga_library`/
 * `manga_categories` rows, and library membership is `manga.in_library`. */
async function migrateAnonymous(
  tx: Tx,
  from_manga_id: string,
  to_manga_id: string,
  options: MigrationOptions,
  summary: MigrationSummary,
): Promise<void> {
  const readChapters = await tx.chapter.findMany({
    where: { manga_id: from_manga_id, is_read: true },
    select: { chapter_number: true },
  });
  summary.progress =
    readChapters.length > 0
      ? Math.floor(Math.max(...readChapters.map((c) => c.chapter_number)))
      : 0;

  const targetIds = await chaptersUpTo(tx, to_manga_id, summary.progress);
  if (targetIds.length > 0) {
    const marked = await tx.chapter.updateMany({
      where: { id: { in: targetIds }, is_read: false },
      data: { is_read: true },
    });
    summary.chapters_marked = marked.count;
  }

  const fromState = await tx.manga_library.findUnique({ where: { manga_id: from_manga_id } });
  if (fromState) {
    await tx.manga_library.upsert({
      where: { manga_id: to_manga_id },
      create: {
        manga_id: to_manga_id,
        is_bookmarked: fromState.is_bookmarked,
        shelf_status: fromState.shelf_status,
        notification_read: fromState.notification_read,
      },
      update: {
        is_bookmarked: fromState.is_bookmarked,
        shelf_status: fromState.shelf_status,
        notification_read: fromState.notification_read,
      },
    });
    summary.state_copied = true;
  }

  const categories = await tx.manga_category.findMany({
    where: { manga_id: from_manga_id },
    select: { category_id: true },
  });
  if (categories.length > 0) {
    const alreadyTagged = await tx.manga_category.findMany({
      where: { manga_id: to_manga_id },
      select: { category_id: true },
    });
    const newTags = excludeExisting(
      categories.map((c) => ({ manga_id: to_manga_id, category_id: c.category_id })),
      alreadyTagged.map((c) => c.category_id),
      (r) => r.category_id,
    );
    if (newTags.length > 0) {
      await tx.manga_category.createMany({ data: newTags });
    }
    // A shared join row has no tombstone, so untagging the old entry is a real delete.
    await tx.manga_category.deleteMany({ where: { manga_id: from_manga_id } });
    summary.categories_moved = categories.length;
  }

  await tx.manga.update({ where: { id: to_manga_id }, data: { in_library: true } });

  if (options.moveHistory) {
    const moved = await tx.history.updateMany({
      where: { manga_id: from_manga_id, user_id: null },
      data: { manga_id: to_manga_id, sync_updated_at: new Date() },
    });
    summary.history_moved = moved.count;
  }

  if (options.removeOld) {
    await tx.manga.update({ where: { id: from_manga_id }, data: { in_library: false } });
    summary.old_entry_removed = true;
  }
}

/** The account half: the same migration against the `user_*` overlay tables, scoped to
 * one account. The shared rows are left completely untouched, so another account's — or
 * the anonymous — view of these titles doesn't change. */
async function migrateForUser(
  tx: Tx,
  user_id: string,
  from_manga_id: string,
  to_manga_id: string,
  options: MigrationOptions,
  summary: MigrationSummary,
): Promise<void> {
  const fromChapters = await tx.chapter.findMany({
    where: { manga_id: from_manga_id },
    select: { id: true, chapter_number: true },
  });
  const readStates = await tx.user_chapter_state.findMany({
    where: { user_id, chapter_id: { in: fromChapters.map((c) => c.id) }, is_read: true },
    select: { chapter_id: true },
  });
  const readIds = new Set(readStates.map((s) => s.chapter_id));
  const readNumbers = fromChapters.filter((c) => readIds.has(c.id)).map((c) => c.chapter_number);
  summary.progress = readNumbers.length > 0 ? Math.floor(Math.max(...readNumbers)) : 0;

  const targetIds = await chaptersUpTo(tx, to_manga_id, summary.progress);
  if (targetIds.length > 0) {
    // Create-then-update: createMany inserts the rows that don't exist yet but leaves
    // existing ones alone, so the updateMany is what flips is_read on those. Only
    // is_read is written — last_page_read and is_bookmark belong to the reader.
    const existingStates = await tx.user_chapter_state.findMany({
      where: { user_id, chapter_id: { in: targetIds } },
      select: { chapter_id: true },
    });
    const newStates = excludeExisting(
      targetIds.map((chapter_id) => ({ user_id, chapter_id, is_read: true })),
      existingStates.map((s) => s.chapter_id),
      (r) => r.chapter_id,
    );
    if (newStates.length > 0) {
      await tx.user_chapter_state.createMany({ data: newStates });
    }
    await tx.user_chapter_state.updateMany({
      where: { user_id, chapter_id: { in: targetIds }, is_read: false },
      data: { is_read: true },
    });
    // Counts rows created and rows flipped alike.
    summary.chapters_marked = targetIds.length;
  }

  const fromState = await tx.user_manga_state.findUnique({
    where: { user_id_manga_id: { user_id, manga_id: from_manga_id } },
  });
  if (fromState) {
    const patch = {
      is_bookmarked: fromState.is_bookmarked,
      shelf_status: fromState.shelf_status,
      score: fromState.score,
      notification_read: fromState.notification_read,
    };
    await tx.user_manga_state.upsert({
      where: { user_id_manga_id: { user_id, manga_id: to_manga_id } },
      create: { user_id, manga_id: to_manga_id, ...patch },
      update: { ...patch, edited_at: null },
    });
    summary.state_copied = true;
  }

  const categories = await tx.user_manga_category.findMany({
    where: { user_id, manga_id: from_manga_id, deleted_at: null },
    select: { category_id: true },
  });
  if (categories.length > 0) {
    const alreadyTagged = await tx.user_manga_category.findMany({
      where: { user_id, manga_id: to_manga_id },
      select: { category_id: true },
    });
    const newTags = excludeExisting(
      categories.map((c) => ({ user_id, manga_id: to_manga_id, category_id: c.category_id })),
      alreadyTagged.map((c) => c.category_id),
      (r) => r.category_id,
    );
    if (newTags.length > 0) {
      await tx.user_manga_category.createMany({ data: newTags });
    }
    // Un-deletes a tagging the reader had previously removed and re-added, which a bare
    // createMany would skip as a duplicate.
    await tx.user_manga_category.updateMany({
      where: {
        user_id,
        manga_id: to_manga_id,
        category_id: { in: categories.map((c) => c.category_id) },
      },
      data: { deleted_at: null, edited_at: null },
    });
    // Tombstone rather than delete: sync has to tell other devices the tag was removed.
    await tx.user_manga_category.updateMany({
      where: { user_id, manga_id: from_manga_id, deleted_at: null },
      data: { deleted_at: new Date(), edited_at: null },
    });
    summary.categories_moved = categories.length;
  }

  await tx.user_library.upsert({
    where: { user_id_manga_id: { user_id, manga_id: to_manga_id } },
    create: { user_id, manga_id: to_manga_id, deleted_at: null },
    update: { deleted_at: null, edited_at: null },
  });

  if (options.moveHistory) {
    const moved = await tx.history.updateMany({
      where: { manga_id: from_manga_id, user_id },
      data: { manga_id: to_manga_id, sync_updated_at: new Date() },
    });
    summary.history_moved = moved.count;
  }

  if (options.removeOld) {
    await tx.user_library.updateMany({
      where: { user_id, manga_id: from_manga_id },
      data: { deleted_at: new Date(), edited_at: null },
    });
    summary.old_entry_removed = true;
  }
}

const migrateManga = async (
  from_manga_id: string,
  to_manga_id: string,
  options: MigrationOptions,
  user_id?: string,
): Promise<MigrationSummary> => {
  if (from_manga_id === to_manga_id) {
    throw new ValidationError('Cannot migrate a title onto itself');
  }

  const summary: MigrationSummary = {
    progress: 0,
    chapters_marked: 0,
    categories_moved: 0,
    history_moved: 0,
    state_copied: false,
    old_entry_removed: false,
  };

  /**
   * Retried as a whole rather than resumed part-way.
   *
   * A title migration holds an interactive transaction for its full duration, which under
   * SQLite blocks every other writer — the download worker and the tracker poll both write
   * on their own schedules, so losing this race is routine rather than exceptional. The
   * transaction is all-or-nothing, so re-running it after a SQLITE_BUSY is safe: nothing
   * from the failed attempt was committed.
   */
  return await withBusyRetry(
    () =>
      prisma.$transaction(async (tx) => {
        // Checked inside the transaction so a title deleted between the check and the work
        // can't leave a migration writing against a row that no longer exists.
        const [from, to] = await Promise.all([
          tx.manga.findUnique({ where: { id: from_manga_id }, select: { id: true } }),
          tx.manga.findUnique({ where: { id: to_manga_id }, select: { id: true } }),
        ]);
        if (!from || !to) {
          throw new MangaNotFoundError('One of the titles to migrate no longer exists');
        }

        if (user_id) {
          await migrateForUser(tx, user_id, from_manga_id, to_manga_id, options, summary);
        } else {
          await migrateAnonymous(tx, from_manga_id, to_manga_id, options, summary);
        }

        return summary;
      }),
    'migrateManga',
  );
};

const migrationService = { migrateManga };

export default migrationService;
