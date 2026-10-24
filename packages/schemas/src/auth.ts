import { z } from 'zod';

export const registerBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    // bcrypt ignores everything past 72 bytes, so a longer password would silently match its prefix.
    .refine((value) => new TextEncoder().encode(value).length <= 72, {
      message: 'Password must be at most 72 bytes',
    }),
  display_name: z
    .string()
    .trim()
    .max(255)
    .transform((name) => name || undefined)
    .optional(),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

/** Deleting an account can't be undone, so it asks for the password again rather than
 * trusting whoever holds an unlocked session. */
export const deleteAccountBodySchema = z.object({
  password: z.string().min(1, 'Password is required'),
});
export type DeleteAccountBody = z.infer<typeof deleteAccountBodySchema>;

// Duplicated from DEVICE_PLATFORM_VALUES in @projekt-manga/types's enums.ts — this package
// has no dependency on packages/types (see package.json), so the two arrays have to be
// kept in sync by hand.
export const DEVICE_PLATFORMS = ['WEB', 'DESKTOP'] as const;

export const registerDeviceBodySchema = z.object({
  label: z.string().trim().min(1).max(255),
  platform: z.enum(DEVICE_PLATFORMS),
});
export type RegisterDeviceBody = z.infer<typeof registerDeviceBodySchema>;
