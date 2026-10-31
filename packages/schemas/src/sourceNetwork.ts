import { z } from 'zod';

/** Printable ASCII only, so a configured User-Agent can never carry a header break. */
export const sourceUserAgentSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[\x20-\x7e]+$/, 'User-Agent must be printable ASCII');

/** An https resolver URL without credentials. Anything else could leak queries in clear
 * text or put a secret where it gets echoed back. */
export const dohUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  }, 'DNS over HTTPS URL must be an https URL without credentials');

/** null turns a setting off, overriding the environment default; omitted leaves it. */
export const updateSourceNetworkConfigBodySchema = z
  .object({
    userAgent: sourceUserAgentSchema.nullable().optional(),
    dohUrl: dohUrlSchema.nullable().optional(),
  })
  .strict();

export type UpdateSourceNetworkConfigBody = z.infer<typeof updateSourceNetworkConfigBodySchema>;
