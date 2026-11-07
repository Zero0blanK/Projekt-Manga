import { z } from 'zod';

export const categoryNameBodySchema = z.object({
  category_name: z.string().trim().min(1, 'category_name is required').max(100),
});
export type CategoryNameBody = z.infer<typeof categoryNameBodySchema>;

/** Categories a device or backup held locally, added to the caller's own list. */
export const categoryImportBodySchema = z.object({
  categories: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        manga_ids: z.array(z.string().min(1).max(100)).max(20000),
      }),
    )
    .max(500),
});
export type CategoryImportBody = z.infer<typeof categoryImportBodySchema>;
