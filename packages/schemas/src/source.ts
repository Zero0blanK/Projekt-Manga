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
  mangaId: z.string().optional(),
});
export type FetchMangaUpdatesBody = z.infer<typeof fetchMangaUpdatesBodySchema>;
