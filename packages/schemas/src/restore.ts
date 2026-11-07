import { z } from 'zod';
import { addMangaBodySchema } from './manga.js';
import { addHistoryBodySchema } from './history.js';
import { SHELF_STATUSES } from './library.js';

/** Maximum serialized restore upload accepted by both the browser and API. */
export const RESTORE_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

const date = z.string().datetime({ offset: true });

const chapter = z.object({
  /** The source's own id for the chapter. Older backups only carry `id`, which held the
   * same value, so it stands in when the key is missing (see `backupChapterKey`). */
  source_chapter_key: z.string().min(1).max(512).optional(),
  id: z.string().min(1).max(512),
  url: z.string(),
  name: z.string().nullable(),
  scanlator: z.string().nullable(),
  chapter_number: z.number(),
  last_page_read: z.number().int().nonnegative(),
  is_read: z.boolean(),
  is_bookmark: z.boolean(),
  release_date: date.nullable(),
  page_count: z.number().int().nonnegative().nullable(),
});

/** A backed-up chapter's source key. Not filled in by the schema itself: a parsed backup
 * is stored as a restore job's payload, which must stay within the upload limit. */
export const backupChapterKey = (item: { id: string; source_chapter_key?: string }) =>
  item.source_chapter_key ?? item.id;

/** A title's local edits, as the details endpoint returns them (`override` on a title). The
 * entry's own title/author/description/status are the edited values; `original` holds the
 * catalog's, which restore writes to the shared row so an edit never leaks into it. A
 * custom cover is a file, not part of the backup, so `has_cover` is ignored. */
const mangaOverride = z.object({
  title: z.string().min(1).max(255).nullable(),
  author: z.string().min(1).max(255).nullable(),
  description: z.string().max(20_000).nullable(),
  /** Normalized on restore like the title's own status; an unknown value is dropped. */
  status: z.string().max(32).nullable(),
  original: z
    .object({
      title: z.string().min(1).max(255),
      author: z.string().min(1),
      description: z.string().nullable(),
      status: z.string().nullable(),
    })
    .optional(),
});

/** Another source's copy of a title, linked under it (manga_links). Named by source and
 * slug, with enough to stand the title up again where the server no longer has it. */
const mangaLink = z.object({
  source: z.string().min(1).max(128),
  slug: z.string().min(1).max(512),
  title: z.string().min(1).max(255),
  author: z.string().max(255),
  thumbnail_url: z.string().max(2048),
  priority: z.number().int().min(0).max(1000),
});

const restoreBackupSchema = z.object({
  jobId: z.string().uuid(),
  mode: z.enum(['merge', 'replace']).default('replace'),
  expectedUserId: z.string().min(1).nullable(),
  version: z.literal(2),
  manga: z
    .array(
      addMangaBodySchema.omit({ chapters: true }).extend({
        id: z.string().min(1).max(512),
        artist: z.string().nullable(),
        rating: z.number().nullable(),
        chapters: z.array(chapter).max(50_000),
        /** Optional: older backups have none, and most titles are never edited. */
        override: mangaOverride.nullable().optional(),
        /** Optional: older backups have none, and most titles draw on one source. */
        links: z.array(mangaLink).max(20).optional(),
      }),
    )
    .max(10_000),
  library: z
    .array(
      z.object({
        manga_id: z.string().min(1).max(512),
        is_bookmarked: z.boolean(),
        shelf_status: z.enum(SHELF_STATUSES).nullable(),
        notification_read: z.boolean(),
        score: z.number().int().min(0).max(100).nullable().optional(),
      }),
    )
    .max(10_000),
  history: z
    .array(
      addHistoryBodySchema.extend({
        manga_id: z.string().nullable().optional(),
        source_chapter_key: z.string().min(1).max(512).nullable().optional(),
        /** Older backups: held the source's key under the old name. */
        chapter_id: z.string().nullable().optional(),
        source_manga_id: z.string().nullable().optional(),
        title: z.string().max(255).nullable().optional(),
        thumbnail_url: z.string().nullable().optional(),
        read_at: date,
        last_read: date,
        last_page_read: z.number().int().nonnegative(),
        is_read: z.boolean().optional(),
        chapter_number: z.number().nullable().optional(),
        page_count: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .max(50_000),
});

function validateRestoreBackup(
  backup: Omit<z.infer<typeof restoreBackupSchema>, 'jobId'>,
  ctx: z.RefinementCtx,
) {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of backup.manga) {
    const key = `${entry.source}\0${entry.slug}`;
    if (ids.has(entry.id) || keys.has(key)) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate title in backup' });
      return;
    }
    ids.add(entry.id);
    keys.add(key);
    // Source keys only name a chapter within its title, so two titles may share one.
    const chapterKeys = new Set<string>();
    for (const item of entry.chapters) {
      const key = backupChapterKey(item);
      if (chapterKeys.has(key)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate chapter in backup' });
        return;
      }
      chapterKeys.add(key);
    }
  }
  if (backup.library.some((state) => !ids.has(state.manga_id))) {
    ctx.addIssue({ code: 'custom', message: 'Library state refers to an absent title' });
  }
  if (new Set(backup.library.map((state) => state.manga_id)).size !== backup.library.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate library state in backup' });
  }
  if (backup.manga.reduce((count, entry) => count + entry.chapters.length, 0) > 50_000) {
    ctx.addIssue({ code: 'custom', message: 'Too many chapters in backup' });
  }
}

export const replaceBackupBodySchema = restoreBackupSchema.superRefine(validateRestoreBackup);

/** Validated backup data for a read-only comparison against the active account's catalog. */
export const previewBackupBodySchema = restoreBackupSchema
  .omit({ jobId: true })
  .superRefine(validateRestoreBackup);

export type ReplaceBackupBody = z.infer<typeof replaceBackupBodySchema>;
export type PreviewBackupBody = z.infer<typeof previewBackupBodySchema>;
