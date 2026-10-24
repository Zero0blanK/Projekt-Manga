import { z } from 'zod';
import { addMangaBodySchema } from './manga.js';
import { addHistoryBodySchema } from './history.js';

/** Maximum serialized restore upload accepted by both the browser and API. */
export const RESTORE_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

const date = z.string().datetime({ offset: true });

const chapter = z.object({
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
      }),
    )
    .max(10_000),
  library: z
    .array(
      z.object({
        manga_id: z.string().min(1).max(512),
        is_bookmarked: z.boolean(),
        shelf_status: z.enum(['READING', 'COMPLETED', 'ON_HOLD', 'PLAN', 'DROPPED']).nullable(),
        notification_read: z.boolean(),
        score: z.number().int().min(0).max(100).nullable().optional(),
      }),
    )
    .max(10_000),
  history: z
    .array(
      addHistoryBodySchema.extend({
        manga_id: z.string().nullable().optional(),
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
  const chapterIds = new Set<string>();
  for (const entry of backup.manga) {
    const key = `${entry.source}\0${entry.slug}`;
    if (ids.has(entry.id) || keys.has(key)) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate title in backup' });
      return;
    }
    ids.add(entry.id);
    keys.add(key);
    for (const item of entry.chapters) {
      if (chapterIds.has(item.id)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate chapter in backup' });
        return;
      }
      chapterIds.add(item.id);
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
