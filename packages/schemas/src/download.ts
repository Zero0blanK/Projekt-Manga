import { z } from 'zod';

export const initiateDownloadBodySchema = z.object({
  sourceId: z.string().min(1),
  mangaSlug: z.string().min(1),
  mangaTitle: z.string().min(1),
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

/** A folder to look for earlier downloads in; without one, the folders the app knows. */
const restoreRootSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  // A drive (C:\ or C:/), a network share (\\server) or a POSIX absolute path.
  .refine((value) => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value), 'Enter a full folder path')
  .optional();

export const scanDownloadsQuerySchema = z.object({ root: restoreRootSchema });
export type ScanDownloadsQuery = z.infer<typeof scanDownloadsQuerySchema>;

export const restoreDownloadsBodySchema = z.object({
  root: restoreRootSchema,
  titles: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(1000),
});
export type RestoreDownloadsBody = z.infer<typeof restoreDownloadsBodySchema>;
