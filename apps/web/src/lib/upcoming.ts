import type { ReleaseEstimate } from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';

export type UpcomingEntry = { manga: Manga; estimate: ReleaseEstimate; expected: Date };
export type UpcomingDay = {
  /** Local calendar day, `YYYY-MM-DD`; 'overdue' for anything expected before today. */
  key: string;
  date: Date | null;
  entries: UpcomingEntry[];
};

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/**
 * Library titles grouped by the local day their next chapter is expected, soonest first.
 * Anything already past due shares one "overdue" group at the top: a late release is
 * still worth checking, but not worth a separate heading per missed day.
 */
export function groupUpcoming(
  library: Manga[],
  estimates: ReleaseEstimate[],
  now = new Date(),
): UpcomingDay[] {
  const byId = new Map(library.map((manga) => [manga.id, manga]));
  const today = startOfDay(now).getTime();
  const days = new Map<string, UpcomingDay>();
  const entries = estimates
    .flatMap((estimate) => {
      const manga = byId.get(estimate.manga_id);
      const expected = new Date(estimate.next_expected_at);
      return manga && Number.isFinite(expected.getTime()) ? [{ manga, estimate, expected }] : [];
    })
    .sort((a, b) => a.expected.getTime() - b.expected.getTime());
  for (const entry of entries) {
    const overdue = startOfDay(entry.expected).getTime() < today;
    const key = overdue ? 'overdue' : dayKey(entry.expected);
    const day = days.get(key) ?? {
      key,
      date: overdue ? null : startOfDay(entry.expected),
      entries: [],
    };
    day.entries.push(entry);
    days.set(key, day);
  }
  return [...days.values()];
}

export { dayKey };
