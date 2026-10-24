import { z } from 'zod';
import { sortBySchema, sortOrderSchema } from './pagination.js';

export const getMangaQuerySchema = z.object({
  sortBy: sortBySchema,
  sortOrder: sortOrderSchema,
});
export type GetMangaQuery = z.infer<typeof getMangaQuerySchema>;

// Matches @projekt-manga/types' Chapters shape (required id/name/url/chapter_number/
// last_page_read/release_date/pages) — defaults fill in anything the caller omits so the
// parsed output satisfies AddMangaPayload without a separate mapping step.
const addMangaChapterSchema = z.object({
  id: z.string().min(1),
  url: z.string().default(''),
  name: z.string().default(''),
  scanlator: z.string().optional(),
  chapter_number: z.number(),
  last_page_read: z.number().default(0),
  release_date: z.string().default(''),
  page_count: z.number().optional(),
  language: z.string().optional(),
  pages: z.array(z.any()).default([]),
});

export const addMangaBodySchema = z.object({
  source: z.string().min(1),
  // Capped at the length the column used to enforce itself. MariaDB's VARCHAR(255)
  // truncated or rejected an over-long title; SQLite's TEXT has no length limit at
  // all, so this schema is now the only thing keeping it bounded.
  title: z.string().min(1).max(255),
  slug: z.string().min(1),
  // The repository defaults a missing author to "Unknown" — mirror that here rather
  // than rejecting the request outright.
  author: z.string().min(1).default('Unknown'),
  thumbnail_url: z.string().min(1),
  artist: z.string().optional(),
  description: z.string(),
  genres: z.string(),
  status: z.string().min(1),
  rating: z.number().optional(),
  in_library: z.boolean().optional(),
  chapters: z.array(addMangaChapterSchema).default([]),
});
export type AddMangaBody = z.infer<typeof addMangaBodySchema>;

/** Toggles library membership for an existing manga row. */
export const updateLibraryMembershipBodySchema = z.object({
  in_library: z.boolean(),
});
export type UpdateLibraryMembershipBody = z.infer<typeof updateLibraryMembershipBodySchema>;

/**
 * Moves a library entry's reading state onto another entry — the "migrate to a different
 * source" flow behind the duplicate-detection dialog.
 *
 * The path parameter is the entry being migrated *from*; `to_manga_id` is the one being
 * migrated to. Both must already exist as rows: migration only ever moves state between
 * them, it never creates either.
 */
export const migrateMangaBodySchema = z.object({
  to_manga_id: z.string().min(1),
  /** Take the old entry out of the library once everything has moved. Default true —
   * leaving both in place is the unusual case (you wanted a copy, not a migration). */
  remove_old: z.boolean().optional().default(true),
  /** Re-point this title's history rows at the new entry. Default true: history keeps its
   * own `source` and `manga_slug`, so re-pointing manga_id preserves *where* each chapter
   * was read while stopping the rows from referencing an entry that just left the
   * library. */
  move_history: z.boolean().optional().default(true),
});
export type MigrateMangaBody = z.infer<typeof migrateMangaBodySchema>;
