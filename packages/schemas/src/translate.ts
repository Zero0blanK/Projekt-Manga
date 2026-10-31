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
