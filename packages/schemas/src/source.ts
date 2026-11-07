import { z } from 'zod';
import { limitQuerySchema, offsetQuerySchema } from './pagination.js';

export const sourceCursorSchema = z.string().min(1).max(1024);
const sourcePageQueryShape = {
  cursor: sourceCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  filters: z.string().optional(),
};
export const sourceCatalogueQuerySchema = z.object({
  ...sourcePageQueryShape,
  category: z.string().optional(),
});
export const sourceSearchPageQuerySchema = z.object({
  ...sourcePageQueryShape,
  query: z.string().optional(),
});
export type SourceCatalogueQuery = z.infer<typeof sourceCatalogueQuerySchema>;
export type SourceSearchPageQuery = z.infer<typeof sourceSearchPageQuerySchema>;

export const sourceMangaQuerySchema = z.object({
  category: z.string().optional(),
  limit: limitQuerySchema,
  offset: offsetQuerySchema,
  /** JSON-encoded object, e.g. filters={"status":"ongoing"} — parsed by the controller,
   * not here, since its shape varies per source. */
  filters: z.string().optional(),
});
export type SourceMangaQuery = z.infer<typeof sourceMangaQuerySchema>;

export const sourceSearchQuerySchema = z.object({
  query: z.string().optional(),
  limit: limitQuerySchema,
  offset: offsetQuerySchema,
  filters: z.string().optional(),
});
export type SourceSearchQuery = z.infer<typeof sourceSearchQuerySchema>;

export const sourceChapterPagesQuerySchema = z.object({
  manga_slug: z.string().optional(),
  limit: limitQuerySchema,
  offset: offsetQuerySchema,
});
export type SourceChapterPagesQuery = z.infer<typeof sourceChapterPagesQuerySchema>;

export const imageProxyQuerySchema = z.object({
  url: z.string().trim().min(1, 'url query param is required'),
  source_id: z.string().optional(),
});
export type ImageProxyQuery = z.infer<typeof imageProxyQuerySchema>;

export const fetchMangaUpdatesBodySchema = z.object({
  manga_id: z.string().optional(),
});
export type FetchMangaUpdatesBody = z.infer<typeof fetchMangaUpdatesBodySchema>;

/** One cookie from the desktop source browser's partition. Bounds mirror the sandbox's
 * own jar limits (apps/extensions/sandbox/cookieJar.ts). */
export const sourceBrowserCookieSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().max(4096),
  domain: z.string().min(1).max(253),
  hostOnly: z.boolean().default(false),
  path: z.string().startsWith('/').max(1024).default('/'),
  secure: z.boolean().default(false),
  httpOnly: z.boolean().default(false),
  /** Unix seconds; omitted for a session cookie. */
  expires: z.number().positive().optional(),
});

export const sourceBrowserSessionBodySchema = z.object({
  userAgent: z.string().min(1).max(512),
  /** Omitted to change only the User-Agent and keep the stored cookies. */
  cookies: z.array(sourceBrowserCookieSchema).max(300).optional(),
});
export type SourceBrowserSessionBody = z.infer<typeof sourceBrowserSessionBodySchema>;

/** Most URLs one key-conversion request may carry; the client splits larger imports. */
export const SOURCE_URL_KEYS_LIMIT = 5_000;
const sourceUrl = z.string().min(1).max(2048);

/** Mihon/Tachiyomi URLs to turn into this app's keys (see `Source.keyFromUrl`). */
export const sourceUrlKeysBodySchema = z
  .object({
    manga: z.array(sourceUrl).max(SOURCE_URL_KEYS_LIMIT).default([]),
    chapters: z.array(sourceUrl).max(SOURCE_URL_KEYS_LIMIT).default([]),
  })
  .refine((body) => body.manga.length + body.chapters.length <= SOURCE_URL_KEYS_LIMIT, {
    message: `At most ${SOURCE_URL_KEYS_LIMIT} URLs per request`,
  });
export type SourceUrlKeysBody = z.infer<typeof sourceUrlKeysBodySchema>;
