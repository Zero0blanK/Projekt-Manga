import type { Manga } from '@/lib/manga-data';
import type { ShelfStatus } from '@/lib/app-store';

/** Statuses that mean no further chapters are coming, so a library update has nothing to
 * find. Matches the values `Manga["status"]` can hold. */
const FINISHED_STATUSES = new Set(['Completed', 'Cancelled']);

/**
 * Whether a library entry is included in a library update run — the set the Update
 * Library button walks, and the number Settings > Statistics reports as "in global
 * update". Both read this so the count can never describe something the button doesn't do.
 */
export function isInGlobalUpdate(
  manga: Manga,
  shelf: Partial<Record<string, ShelfStatus>>,
  skipCompleted: boolean,
): boolean {
  if (!skipCompleted) return true;
  if (shelf[manga.id] === 'completed') return false;
  return !FINISHED_STATUSES.has(manga.status);
}

export function entriesInGlobalUpdate(
  manga: Manga[],
  shelf: Partial<Record<string, ShelfStatus>>,
  skipCompleted: boolean,
): Manga[] {
  return manga.filter((m) => isInGlobalUpdate(m, shelf, skipCompleted));
}

/** Entries that have been opened but not finished — at least one chapter read, with
 * chapters still to go. */
export function isStarted(manga: Manga): boolean {
  const progress = manga.progress ?? 0;
  return progress > 0 && progress < 1;
}
