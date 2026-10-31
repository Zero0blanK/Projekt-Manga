/**
 * Reading goals and the yearly "year in manga", computed in the browser from reading
 * history: one entry per chapter, stamped with when it was last read and how long it was
 * read for. Nothing here leaves the device.
 */
import type { HistoryEntry } from '@projekt-manga/api-client';

export const READING_GOAL_COUNT = 'readingGoalCount';
export const READING_GOAL_PERIOD = 'readingGoalPeriod';
export const GOAL_PERIODS = ['Week', 'Month'] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];
export const GOAL_COUNTS = [0, 3, 5, 7, 10, 15, 20, 30, 50, 100] as const;

type Entry = Pick<HistoryEntry, 'last_read' | 'time_read' | 'title' | 'manga_id' | 'manga_slug'>;

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The start of the current goal period, local time: Monday for weeks, the 1st for months. */
export function periodStart(period: GoalPeriod, now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'Month') start.setDate(1);
  else start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

/** Chapters read since the period began, against the goal. */
export function goalProgress(
  history: readonly Entry[],
  goal: { count: number; period: GoalPeriod },
  now = new Date(),
) {
  const since = periodStart(goal.period, now).getTime();
  const read = history.filter((entry) => {
    const at = Date.parse(entry.last_read);
    return Number.isFinite(at) && at >= since && at <= now.getTime();
  }).length;
  return {
    read,
    goal: goal.count,
    fraction: goal.count > 0 ? Math.min(1, read / goal.count) : 0,
    met: goal.count > 0 && read >= goal.count,
  };
}

/** The years history has entries in, newest first. */
export function historyYears(history: readonly Entry[]): number[] {
  const years = new Set<number>();
  for (const entry of history) {
    const at = new Date(entry.last_read);
    if (!Number.isNaN(at.getTime())) years.add(at.getFullYear());
  }
  return [...years].sort((a, b) => b - a);
}

/** The longest run of consecutive days with reading, among `days` (day keys). */
function longestStreak(days: ReadonlySet<string>): number {
  let best = 0;
  for (const key of days) {
    const date = new Date(`${key}T00:00:00`);
    const previous = new Date(date);
    previous.setDate(previous.getDate() - 1);
    if (days.has(dayKey(previous))) continue; // not the start of a run
    let length = 1;
    const cursor = new Date(date);
    for (;;) {
      cursor.setDate(cursor.getDate() + 1);
      if (!days.has(dayKey(cursor))) break;
      length++;
    }
    best = Math.max(best, length);
  }
  return best;
}

export interface YearInManga {
  year: number;
  chapters: number;
  titles: number;
  /** Reading time, from what the reader measured. */
  hours: number;
  longestStreak: number;
  busiestDay: { date: string; chapters: number } | null;
  /** Chapters per month, January first. */
  months: number[];
  topTitles: Array<{ title: string; chapters: number }>;
  topGenres: Array<{ genre: string; chapters: number }>;
}

/**
 * One year of reading. `genresOf` names a title's genres (from the library), keyed by
 * manga id or slug, for the genre ranking; titles outside the library count without one.
 */
export function yearInManga(
  history: readonly Entry[],
  year: number,
  genresOf: (entry: Entry) => readonly string[] = () => [],
): YearInManga {
  const entries = history.filter((entry) => new Date(entry.last_read).getFullYear() === year);
  const months = Array.from({ length: 12 }, () => 0);
  const perDay = new Map<string, number>();
  const perTitle = new Map<string, number>();
  const perGenre = new Map<string, number>();
  let ms = 0;
  for (const entry of entries) {
    const at = new Date(entry.last_read);
    months[at.getMonth()]++;
    const key = dayKey(at);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
    const title = entry.title?.trim() || entry.manga_slug;
    perTitle.set(title, (perTitle.get(title) ?? 0) + 1);
    for (const genre of genresOf(entry)) perGenre.set(genre, (perGenre.get(genre) ?? 0) + 1);
    ms += Math.max(0, entry.time_read ?? 0);
  }
  const busiest = [...perDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const rank = (map: Map<string, number>) =>
    [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  return {
    year,
    chapters: entries.length,
    titles: perTitle.size,
    hours: Math.round((ms / 3_600_000) * 10) / 10,
    longestStreak: longestStreak(new Set(perDay.keys())),
    busiestDay: busiest ? { date: busiest[0], chapters: busiest[1] } : null,
    months,
    topTitles: rank(perTitle).map(([title, chapters]) => ({ title, chapters })),
    topGenres: rank(perGenre).map(([genre, chapters]) => ({ genre, chapters })),
  };
}
