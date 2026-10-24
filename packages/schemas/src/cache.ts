import { z } from 'zod';

// Both casings are accepted (cache.controller.ts ORs them together) for compatibility with
// an older caller. New code should send source_thumbnail_url — that's what api-client's
// triggerCacheSync actually sends.
export const triggerSyncBodySchema = z.object({
  source_thumbnail_url: z.string().optional(),
  sourceThumbnailUrl: z.string().optional(),
});
export type TriggerSyncBody = z.infer<typeof triggerSyncBodySchema>;
