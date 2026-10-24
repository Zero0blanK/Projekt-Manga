import { z } from 'zod';

/** Partial chapter metadata sent when a chapter may not exist in the DB yet — matches
 * apps/server's `Partial<Chapters> & { source?: string }`. All optional: only what's
 * present gets used to create the placeholder row (chapter.service.ts's
 * ensureChapterExists supplies its own defaults for anything missing). */
export const chapterMetaSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
    chapter_number: z.number().optional(),
    scanlator: z.string().optional(),
    last_page_read: z.number().optional(),
    page_count: z.number().optional(),
    release_date: z.string().optional(),
    source: z.string().optional(),
  })
  // Passthrough so fields this schema doesn't enumerate (e.g. pages, language) still reach
  // ensureChapterExists as part of chapter_data, unvalidated — tightening this to .strict()
  // would silently drop them instead.
  .passthrough();
export type ChapterMetaBody = z.infer<typeof chapterMetaSchema>;

export const chaptersBulkBodySchema = z.object({
  chapters: z.array(chapterMetaSchema).optional(),
  source_manga_id: z.string().min(1).optional(),
  /** Manga-level display fields for the history rows this writes. Needed for titles read
   * straight from a source, which have no `manga` row to join a title/cover from — these
   * populate the existing `history.title` / `history.thumbnail_url` columns. Sent once
   * for the batch rather than repeated on every chapter. */
  // Capped at the length the column used to enforce itself. MariaDB's VARCHAR(255)
  // truncated or rejected an over-long title; SQLite's TEXT has no length limit at
  // all, so this schema is now the only thing keeping it bounded.
  title: z.string().max(255).optional(),
  thumbnail_url: z.string().optional(),
});
export type ChaptersBulkBody = z.infer<typeof chaptersBulkBodySchema>;

/** Unlike chapterMetaSchema, this goes straight to chapterRepository.addChapterAsHistory
 * with no intermediate defaulting step, and several of its columns are non-null in the
 * database — so this schema supplies the defaults itself. */
export const addChapterAsHistoryBodySchema = z.object({
  id: z.string().min(1, 'id is required'),
  name: z.string().default(''),
  url: z.string().default(''),
  chapter_number: z.number().default(0),
  scanlator: z.string().optional(),
  last_page_read: z.number().default(0),
  page_count: z.number().optional(),
  release_date: z.string().default(''),
  language: z.string().optional(),
  pages: z.array(z.any()).default([]),
});
export type AddChapterAsHistoryBody = z.infer<typeof addChapterAsHistoryBodySchema>;
