import { z } from 'zod';
import { sourceCursorSchema } from './source.js';

/**
 * What an installed source is allowed to hand back.
 *
 * Every value here is produced by a third-party bundle downloaded from a repository the
 * user added — the same untrusted code the sandbox exists to contain. The sandbox stops it
 * reading the filesystem, the environment or the network; it does nothing about the *shape*
 * of what it returns, and TypeScript's `Promise<Mangas[]>` on the other side of the IPC
 * boundary is erased at runtime, so `source.fetchManga()` was an unchecked cast of
 * arbitrary JSON straight into the API's responses.
 *
 * ## Deliberately permissive
 *
 * These schemas are a guard against malformed output, not a conformance test for sources.
 * A source that returns something extra is fine — objects are `passthrough()` so unknown keys
 * survive untouched, exactly as they did before. Only the fields the app actually reads are
 * required, and anything the app can sensibly default is optional. The bar is "can the app
 * use this without breaking", not "did the author read the spec".
 *
 * That matters because the failure mode of over-strict validation here is worse than the
 * bug being fixed: it would break working sources that the user cannot patch, on an app
 * they'd have to wait for a new build of. When in doubt these accept.
 */

/** Coerces the numeric fields sources most often send as strings ("12", "3.5").
 *
 * `z.coerce.number()` alone would also turn `null`, `""` and `[]` into 0, which silently
 * invents a chapter number rather than reporting bad data — so only actual numbers and
 * numeric strings are accepted. */
const looseNumber = z.union([
  z.number().finite(),
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
]);

export const sourceMangaSchema = z
  .object({
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().min(1),
    // Sources routinely omit these two — the caller already knows which source it asked,
    // and a missing cover is a rendering concern, not a reason to discard the title.
    source: z.string().optional().default(''),
    thumbnail_url: z.string().optional().default(''),
  })
  .passthrough();

export const sourcePageSchema = z
  .object({
    index: looseNumber,
    // Accepts missing/null: a page whose image failed to resolve is a real, representable
    // state, not a validation failure.
    image_url: z.string().nullish(),
  })
  .passthrough()
  // Normalised at the object level rather than on the field so the key is always *present*
  // (as `string | undefined`) rather than optional — `Page.image_url` is a required
  // property that happens to allow undefined, and an optional key does not satisfy it.
  .transform((page) => ({ ...page, image_url: page.image_url ?? undefined }));

export const sourceChapterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional().default(''),
    url: z.string().optional().default(''),
    chapter_number: looseNumber,
    scanlator: z.string().optional(),
    is_read: z.boolean().optional(),
    is_bookmark: z.boolean().optional(),
    last_page_read: looseNumber.optional().default(0),
    fetched_at: z.string().optional(),
    release_date: z.string().optional().default(''),
    page_count: looseNumber.optional(),
    language: z.string().optional(),
    pages: z.array(sourcePageSchema).optional().default([]),
  })
  .passthrough();

export const sourceMangaDetailsSchema = sourceMangaSchema
  .extend({
    // Dropped rather than rejected when malformed: it only feeds "Copy link", which can
    // degrade gracefully, so it must not cost the reader the whole title.
    url: z.string().optional().catch(undefined),
    // Several sources send a bare string where the contract says string[]; normalising here
    // beats every consumer having to remember which shape it got.
    author: z.union([z.array(z.string()), z.string().transform((s) => [s])]).optional(),
    artist: z.union([z.array(z.string()), z.string().transform((s) => [s])]).optional(),
    groups: z.union([z.array(z.string()), z.string().transform((s) => [s])]).optional(),
    description: z.string().optional().default(''),
    genres: z
      .union([z.array(z.string()), z.string().transform((s) => (s ? s.split(/\s*,\s*/) : []))])
      .optional()
      .default([]),
    // Raw source text. `toMangaStatus()` in apps/server normalises it at the point it is
    // stored, so anything unrecognised becomes UNKNOWN rather than being rejected here.
    status: z.string().optional().default(''),
    chapters: z.array(sourceChapterSchema).optional().default([]),
  })
  .passthrough();

export const sourceMangaFilterSchema = z
  .object({
    label: z.string(),
    value: z.string(),
    type: z.enum(['input', 'select', 'checkbox', 'radio', 'multi', 'tri-state']),
    options: z.array(z.object({ label: z.string(), value: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export const sourceMangaListSchema = z.array(sourceMangaSchema);
export const sourceCapabilitiesSchema = z.object({
  latest: z.boolean(),
  search: z.boolean(),
  filters: z.boolean(),
  languageFilter: z.boolean(),
  urlSearch: z.boolean(),
  nativePagination: z.boolean(),
});
export const sourceCataloguePageSchema = z
  .object({
    items: sourceMangaListSchema.max(200),
    hasMore: z.boolean(),
    nextCursor: sourceCursorSchema.optional(),
  })
  .superRefine((page, context) => {
    if (page.hasMore && (!page.items.length || !page.nextCursor)) {
      context.addIssue({ code: 'custom', message: 'A continuing page needs items and a cursor' });
    }
    if (!page.hasMore && page.nextCursor !== undefined) {
      context.addIssue({ code: 'custom', message: 'A terminal page cannot have a cursor' });
    }
  });
export const sourceChapterListSchema = z.array(sourceChapterSchema);
export const sourceMangaFilterListSchema = z.array(sourceMangaFilterSchema);

export const sourceChapterPagesSchema = z
  .object({
    items: z.array(sourcePageSchema),
    // Defaulted from the page count rather than required: `total` only drives pagination,
    // and a source that omits it is far more common than one that gets it wrong.
    total: looseNumber.optional(),
  })
  .passthrough()
  .transform((result) => ({ ...result, total: result.total ?? result.items.length }));

export type SourceMangaOutput = z.infer<typeof sourceMangaSchema>;
export type SourceMangaDetailsOutput = z.infer<typeof sourceMangaDetailsSchema>;
export type SourceChapterOutput = z.infer<typeof sourceChapterSchema>;
