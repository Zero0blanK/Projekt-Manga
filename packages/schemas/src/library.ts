import { z } from 'zod';

// Duplicated from SHELF_STATUS_VALUES in @projekt-manga/types's enums.ts — this package
// has no dependency on packages/types (see package.json), so the two arrays have to be
// kept in sync by hand.
export const SHELF_STATUSES = ['READING', 'COMPLETED', 'ON_HOLD', 'PLAN', 'DROPPED'] as const;

export const updateLibraryStateBodySchema = z
  .object({
    is_bookmarked: z.boolean().optional(),
    shelf_status: z.enum(SHELF_STATUSES).nullable().optional(),
    // Account-only in practice (no anonymous personal-rating table) — library.service.ts
    // strips this before it ever reaches the anonymous manga_library repository.
    score: z.number().int().min(0).max(100).nullable().optional(),
    notification_read: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.is_bookmarked !== undefined ||
      v.shelf_status !== undefined ||
      v.score !== undefined ||
      v.notification_read !== undefined,
    {
      message: 'At least one of is_bookmarked, shelf_status, score, notification_read is required',
    },
  );
export type UpdateLibraryStateBody = z.infer<typeof updateLibraryStateBodySchema>;
