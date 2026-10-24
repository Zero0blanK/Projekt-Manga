import { z } from 'zod';
import { limitQuerySchema } from './pagination.js';

export const updateLogQuerySchema = z.object({
  limit: limitQuerySchema,
});
export type UpdateLogQuery = z.infer<typeof updateLogQuerySchema>;
