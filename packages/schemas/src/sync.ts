import { z } from 'zod';
import { SHELF_STATUSES } from './library.js';

/** A device pushes only the rows it changed since its last successful push, one array
 * per domain, all optional (a device with nothing new for a domain just omits it). Every
 * row carries its own `updated_at` — the server never trusts wall-clock arrival order,
 * only this client-reported timestamp, to decide the merge outcome. */

const libraryRowSchema = z.object({
  manga_id: z.string().min(1),
  deleted_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime(),
});

const mangaStateRowSchema = z.object({
  manga_id: z.string().min(1),
  is_bookmarked: z.boolean(),
  shelf_status: z.enum(SHELF_STATUSES).nullable(),
  notification_read: z.boolean(),
  updated_at: z.string().datetime(),
});

/** Chapters are named by the source's key within their title, not by row id: a device can
 * read a chapter before it has ever pulled that title, and each side keeps its own rows. */
const chapterRef = {
  source: z.string().min(1).max(255),
  manga_slug: z.string().min(1).max(512),
  source_chapter_key: z.string().min(1).max(512),
};

const chapterStateFields = {
  is_read: z.boolean(),
  is_bookmark: z.boolean(),
  last_page_read: z.number().int().min(0),
  updated_at: z.string().datetime(),
};

/** A chapter's state, named by key. Clients from before keys name the chapter by the
 * server's row id instead (`chapter_id`); the server looks that row up, so an older
 * desktop's push still applies until it updates. */
const chapterStateRowSchema = z.union([
  z.object({ ...chapterRef, ...chapterStateFields }),
  z.object({ chapter_id: z.string().min(1).max(512), ...chapterStateFields }),
]);

/** Categories are referenced by name, not id — the pushing device may have created one
 * locally that the server has never seen, so the sync service resolves it via
 * find-or-create in the account's own list before recording the assignment. */
const mangaCategoryRowSchema = z.object({
  manga_id: z.string().min(1),
  category_name: z.string().trim().min(1).max(255),
  deleted_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime(),
});

const historyRowSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  manga_id: z.string().min(1).nullable(),
  manga_slug: z.string().min(1),
  source_manga_id: z.string().min(1).nullable().optional(),
  title: z.string().max(255).nullable(),
  thumbnail_url: z.string().nullable(),
  // Null for a title-level entry. Older clients send the chapter's row id as
  // `chapter_id` instead; the server translates it.
  source_chapter_key: chapterRef.source_chapter_key.nullable().default(null),
  chapter_id: z.string().min(1).max(512).nullable().optional(),
  read_at: z.string().datetime(),
  last_read: z.string().datetime(),
  pages_read: z.number().int().min(0),
  time_read: z.number().int().min(0),
  deleted_at: z.string().datetime().nullable(),
});

export const syncPushBodySchema = z.object({
  generation: z.number().int().nonnegative().optional(),
  library: z.array(libraryRowSchema).max(1000).optional(),
  manga_state: z.array(mangaStateRowSchema).max(1000).optional(),
  chapter_state: z.array(chapterStateRowSchema).max(5000).optional(),
  manga_category: z.array(mangaCategoryRowSchema).max(1000).optional(),
  history: z.array(historyRowSchema).max(1000).optional(),
});
export type SyncPushBody = z.infer<typeof syncPushBodySchema>;

export const syncPullQuerySchema = z.object({
  since: z.union([z.string().datetime(), z.string().startsWith('v1.').max(4096)]).optional(),
});
export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;
