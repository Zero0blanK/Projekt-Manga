import { z } from 'zod';

/** Automatic backup file names, as the server writes them. Anything else is refused so a
 * name can never climb out of the owner's backup folder. */
export const BACKUP_FILE_NAME_PATTERN = /^projektmanga-[0-9TZ-]+\.json$/;

export const backupFileNameSchema = z.string().regex(BACKUP_FILE_NAME_PATTERN);

export const updateBackupConfigBodySchema = z
  .object({
    intervalHours: z
      .number()
      .int()
      .min(0)
      .max(24 * 30)
      .optional(),
    keep: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type UpdateBackupConfigBody = z.infer<typeof updateBackupConfigBodySchema>;
