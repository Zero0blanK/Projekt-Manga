import { z } from 'zod';

// Duplicated from TRACKER_SERVICE_VALUES in @projekt-manga/types's enums.ts — this package
// has no dependency on packages/types (see package.json), so the two arrays have to be
// kept in sync by hand.
export const TRACKER_SERVICES = [
  'ANILIST',
  'MYANIMELIST',
  'KITSU',
  'MANGAUPDATES',
  'SHIKIMORI',
  'BANGUMI',
  'KOMGA',
  'KAVITA',
] as const;

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

/**
 * Credentials for the trackers that don't use an OAuth redirect: username/password
 * (Kitsu, MangaUpdates) or a self-hosted server's base URL plus API key (Komga, Kavita).
 * Every field is optional here because which pair is required depends on the tracker —
 * the server checks that against the tracker's own auth kind.
 */
export const connectTrackerBodySchema = z.object({
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().min(1).max(1024).optional(),
  base_url: z.string().trim().url().max(2048).optional(),
  api_key: z.string().trim().min(1).max(1024).optional(),
});
export type ConnectTrackerBody = z.infer<typeof connectTrackerBodySchema>;
