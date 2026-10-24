import type { ShelfStatus } from '@/lib/app-store';
import type { Manga } from '@/lib/manga-data';

export const filters: Array<{ label: string; value: 'all' | ShelfStatus }> = [
  { label: 'All', value: 'all' },
  { label: 'Reading', value: 'reading' },
  { label: 'Completed', value: 'completed' },
  { label: 'On Hold', value: 'on-hold' },
  { label: 'Plan to Read', value: 'plan' },
  { label: 'Dropped', value: 'dropped' },
];

export const sorts = [
  { value: 'latest', label: 'Latest Chapter' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Rating' },
  { value: 'progress', label: 'Progress' },
  { value: 'lastRead', label: 'Last Read' },
] as const;

/**
 * A manga's shelf, or null when it hasn't been put on one. Library membership and shelf
 * are separate: everything added shows under "All", and a shelf is an explicit extra
 * choice. Nothing is inferred, so untouched titles never appear under a shelf the user
 * didn't pick.
 */
export function shelfOf(m: Manga, shelf: Partial<Record<string, ShelfStatus>>): ShelfStatus | null {
  return shelf[m.id] ?? null;
}
