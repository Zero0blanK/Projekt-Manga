import { z } from 'zod';
import {
  sortBySchema,
  sortOrderSchema,
  limitQuerySchema,
  offsetQuerySchema,
} from './pagination.js';

export const getMangaQuerySchema = z.object({
  sortBy: sortBySchema,
  sortOrder: sortOrderSchema,
  limit: limitQuerySchema,
  offset: offsetQuerySchema,
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

// Duplicated from MANGA_STATUS_VALUES in @projekt-manga/types's enums.ts — this package
// does not depend on types, so keep the two lists in step.
export const mangaStatusSchema = z.enum(['ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED', 'UNKNOWN']);

/**
 * A reader's own edit to a title, laid over the shared catalog (see manga_override in the
 * server schema). An omitted field is left as it is; `null` clears it so the source's value
 * shows through again. Title and author cannot be blank — clearing one means "use the
 * source's", which is `null`.
 */
export const updateMangaOverrideBodySchema = z
  .object({
    title: z.string().trim().min(1).max(255).nullable().optional(),
    author: z.string().trim().min(1).max(255).nullable().optional(),
    description: z.string().max(20_000).nullable().optional(),
    status: mangaStatusSchema.nullable().optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to change',
  });
export type UpdateMangaOverrideBody = z.infer<typeof updateMangaOverrideBodySchema>;

/** Links another source's copy of a title under this library entry. */
export const createMangaLinkBodySchema = z
  .object({ linked_manga_id: z.string().trim().min(1).max(512) })
  .strict();
export type CreateMangaLinkBody = z.infer<typeof createMangaLinkBodySchema>;

/** The order linked sources are tried in: every link of the title, once each. */
export const reorderMangaLinksBodySchema = z
  .object({ link_ids: z.array(z.string().min(1).max(64)).min(1).max(20) })
  .strict();
export type ReorderMangaLinksBody = z.infer<typeof reorderMangaLinksBodySchema>;

/** Largest custom cover accepted, before base64 encoding. */
export const MANGA_COVER_MAX_BYTES = 5 * 1024 * 1024;

export const MANGA_COVER_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
] as const;

/**
 * A custom cover, sent as base64 inside JSON rather than as a raw or multipart body: the
 * server refuses non-JSON writes so a cross-site form can never reach it. The server checks
 * the decoded bytes' magic number against `mime` and the size limit again.
 */
export const uploadMangaCoverBodySchema = z
  .object({
    mime: z.enum(MANGA_COVER_MIME_TYPES),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(MANGA_COVER_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type UploadMangaCoverBody = z.infer<typeof uploadMangaCoverBodySchema>;
