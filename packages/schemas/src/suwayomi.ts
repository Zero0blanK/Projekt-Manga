import { z } from 'zod';

/**
 * The host's Suwayomi server connection. Suwayomi usually runs on the same machine or the
 * LAN, so private addresses are allowed here: the API only ever talks to this one origin.
 * `password` is write-only: leaving it out keeps the saved one, `clear_password` removes it.
 */
export const suwayomiServerUrlSchema = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Use an http or https URL')
  .refine((value) => {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  }, 'Use the server URL alone, without credentials or a query');

export const suwayomiSettingsBodySchema = z
  .object({
    enabled: z.boolean(),
    url: suwayomiServerUrlSchema,
    username: z
      .string()
      .trim()
      .max(200)
      .regex(/^[^:\r\n]*$/, 'A username cannot contain a colon or a line break')
      .nullable()
      .optional(),
    password: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[^\r\n]*$/, 'A password cannot contain a line break')
      .optional(),
    clear_password: z.boolean().optional(),
  })
  .strict()
  .refine((body) => !(body.password && body.clear_password), {
    message: 'Send a new password or clear it, not both',
  });
export type SuwayomiSettingsBody = z.infer<typeof suwayomiSettingsBodySchema>;

/** A Suwayomi extension's package name, as its URL segment. */
export const suwayomiExtensionParamsSchema = z.object({
  pkg_name: z.string().regex(/^[A-Za-z0-9_.]{1,200}$/, 'Not an extension package name'),
});

export const suwayomiExtensionActionBodySchema = z
  .object({ action: z.enum(['install', 'update', 'uninstall']) })
  .strict();
export type SuwayomiExtensionActionBody = z.infer<typeof suwayomiExtensionActionBodySchema>;
