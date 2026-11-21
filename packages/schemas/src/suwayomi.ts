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

/** Where Suwayomi sources come from: the built-in extension engine, the user's own
 * Suwayomi server, or nowhere. */
export const suwayomiModeBodySchema = z
  .object({ mode: z.enum(['built-in', 'external', 'off']) })
  .strict();
export type SuwayomiModeBody = z.infer<typeof suwayomiModeBodySchema>;

/** The built-in engine's settings: its Java memory limit, and whether it starts with the
 * server. Either or both. */
export const suwayomiEngineSettingsBodySchema = z
  .object({
    memory_mb: z.number().int().min(256).max(8192).optional(),
    start_with_server: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.memory_mb !== undefined || body.start_with_server !== undefined, {
    message: 'Send a memory limit, start with the server, or both',
  });
export type SuwayomiEngineSettingsBody = z.infer<typeof suwayomiEngineSettingsBodySchema>;

/** Removing the built-in engine; its extensions and their settings go too unless kept. */
export const suwayomiEngineRemoveQuerySchema = z
  .object({ keep_data: z.enum(['true', 'false']).optional() })
  .strict();

/** The engine's extension repositories: index URLs the user adds themselves. */
export const suwayomiEngineRepositoriesBodySchema = z
  .object({
    repositories: z
      .array(
        z
          .string()
          .trim()
          .max(2000)
          .url()
          .refine((value) => /^https:\/\//i.test(value), 'Use an https URL')
          .refine((value) => {
            const parsed = new URL(value);
            return !parsed.username && !parsed.password && !parsed.hash;
          }, 'Use the repository URL alone, without credentials'),
      )
      .max(20),
  })
  .strict();
export type SuwayomiEngineRepositoriesBody = z.infer<typeof suwayomiEngineRepositoriesBodySchema>;
