import { z } from 'zod';

/**
 * Largest page a caller may ask for.
 *
 * Bounded rather than open-ended: `limit` is passed straight through to Prisma's `take`,
 * and the source-browsing schemas below use it for upstream page sizes too, so an
 * unbounded value lets one request ask for the entire table (or the largest page a source
 * will serve) in a single response. 200 is well above any page this UI renders.
 */
export const MAX_PAGE_LIMIT = 200;

/** Query-string numbers arrive as strings; z.coerce handles the conversion + validates
 * it actually parsed to a real number. */
export const limitQuerySchema = z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).optional();
export const offsetQuerySchema = z.coerce.number().int().nonnegative().optional();

export const sortBySchema = z.enum(['title', 'dateAdded', 'recentlyRead']).optional();
export const sortOrderSchema = z.enum(['asc', 'desc']).optional();
