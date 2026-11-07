import { z } from 'zod';

export const triggerSyncBodySchema = z.object({
  source_thumbnail_url: z.string().optional(),
});
export type TriggerSyncBody = z.infer<typeof triggerSyncBodySchema>;
