import { z } from 'zod';

export const addHistoryBodySchema = z.object({
  source: z.string().min(1),
  manga_id: z.string().optional(),
  manga_slug: z.string().min(1),
  source_manga_id: z.string().min(1).optional(),
  // Capped at the length the column used to enforce itself. MariaDB's VARCHAR(255)
  // truncated or rejected an over-long title; SQLite's TEXT has no length limit at
  // all, so this schema is now the only thing keeping it bounded.
  title: z.string().max(255).optional(),
  chapter_id: z.string().optional(),
  thumbnail_url: z.string().optional(),
  pages_read: z.number().int().nonnegative().default(1),
  time_read: z.number().int().nonnegative().optional(),
});
export type AddHistoryBody = z.infer<typeof addHistoryBodySchema>;
