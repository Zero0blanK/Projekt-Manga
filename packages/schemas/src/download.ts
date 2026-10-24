import { z } from 'zod';

export const initiateDownloadBodySchema = z.object({
  sourceId: z.string().min(1),
  mangaSlug: z.string().min(1),
  mangaTitle: z.string().min(1),
  downloadPath: z.string().optional(),
  chapter: z.object({
    id: z.string().min(1, 'chapter.id is required'),
    name: z.string().optional(),
    chapter_number: z.number(),
  }),
});
export type InitiateDownloadBody = z.infer<typeof initiateDownloadBodySchema>;

export const updateDownloadDirectoryBodySchema = z.object({
  path: z.string().optional(),
});
export type UpdateDownloadDirectoryBody = z.infer<typeof updateDownloadDirectoryBodySchema>;

export const updateDownloadStorageLimitBodySchema = z.object({
  bytes: z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type UpdateDownloadStorageLimitBody = z.infer<typeof updateDownloadStorageLimitBodySchema>;

export const cleanupOrphanedDownloadsBodySchema = z.object({
  ids: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(200),
});
export type CleanupOrphanedDownloadsBody = z.infer<typeof cleanupOrphanedDownloadsBodySchema>;
