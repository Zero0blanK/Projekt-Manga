import { z } from 'zod';

/** Languages a page can be translated into from Japanese, by both supported services. */
export const translateTargets = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'id',
  'ru',
  'zh',
  'ko',
] as const;
export const translateTargetSchema = z.enum(translateTargets);
export type TranslateTarget = z.infer<typeof translateTargetSchema>;

/** The text of one page's speech bubbles, read on the device, to translate from Japanese. */
export const translateBodySchema = z
  .object({
    texts: z.array(z.string().trim().min(1).max(2000)).min(1).max(60),
    target: translateTargetSchema,
  })
  .strict();
export type TranslateBody = z.infer<typeof translateBodySchema>;

export const translateProviders = ['libretranslate', 'deepl'] as const;
export const translateProviderSchema = z.enum(translateProviders);
export type TranslateProvider = z.infer<typeof translateProviderSchema>;

/**
 * Saving a reader's own translation service. `api_key` is write-only: leaving it out keeps
 * the saved key, `clear_api_key` removes it. The key is never sent back.
 */
export const translateSettingsBodySchema = z
  .object({
    provider: translateProviderSchema,
    url: z
      .string()
      .trim()
      .max(500)
      .url()
      .refine((value) => /^https?:\/\//i.test(value), 'Use an http or https URL')
      .refine((value) => {
        const parsed = new URL(value);
        return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
      }, 'Use the service URL alone, without credentials or a query')
      .optional(),
    api_key: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^[\x21-\x7e]+$/, 'An API key is printable characters without spaces')
      .optional(),
    clear_api_key: z.boolean().optional(),
  })
  .strict()
  .refine((body) => !(body.api_key && body.clear_api_key), {
    message: 'Send a new key or clear it, not both',
  });
export type TranslateSettingsBody = z.infer<typeof translateSettingsBodySchema>;
