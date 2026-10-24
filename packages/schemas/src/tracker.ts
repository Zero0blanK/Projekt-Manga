import { z } from 'zod';

// Duplicated from TRACKER_SERVICE_VALUES in @projekt-manga/types's enums.ts — this package
// has no dependency on packages/types (see package.json), so the two arrays have to be
// kept in sync by hand.
export const TRACKER_SERVICES = ['ANILIST', 'MYANIMELIST'] as const;

export const trackerCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
export type TrackerCallbackQuery = z.infer<typeof trackerCallbackQuerySchema>;

export const trackerSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(255),
});
export type TrackerSearchQuery = z.infer<typeof trackerSearchQuerySchema>;

export const linkTrackerBodySchema = z.object({
  tracker: z.enum(TRACKER_SERVICES),
  tracker_media_id: z.string().min(1),
});
export type LinkTrackerBody = z.infer<typeof linkTrackerBodySchema>;
