import { z } from 'zod';

export const categoryNameBodySchema = z.object({
  category_name: z.string().trim().min(1, 'category_name is required'),
});
export type CategoryNameBody = z.infer<typeof categoryNameBodySchema>;
