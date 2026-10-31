/**
 * When a title's next chapter is likely to appear, from when its recent chapters did.
 * Feeds "smart update" (scheduled library updates skip titles not due yet) and the
 * Upcoming page.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Chapters considered: recent cadence matters, a series' early years don't. */
const RECENT_CHAPTERS = 10;
/** Fewer gaps than this is a guess, not a cadence. */
const MIN_GAPS = 2;
/** Same-day batches count as one release, and a series quiet longer than this has no
 * schedule worth predicting. */
const MIN_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 60;
/** A series this far past its expected release has stalled (hiatus, or finished without
 * being marked so): no estimate, rather than an "overdue" entry that never goes away. */
const STALLED_INTERVALS = 3;
const STALLED_MIN_DAYS = 14;

export interface ReleaseEstimate {
  interval_days: number;
  next_expected_at: Date;
  last_chapter_at: Date;
}

export interface DatedChapter {
  chapter_number: number;
  /** The source's release date, or failing that when the chapter was first seen. */
  date: Date | null;
}

/**
 * The median gap between the last few distinct releases, or null when there isn't enough
 * history. A chapter number listed by several groups counts once, at its earliest date,
 * so parallel scanlations don't read as a twice-weekly schedule.
 */
export function estimateRelease(
  chapters: DatedChapter[],
  now = Date.now(),
): ReleaseEstimate | null {
  const firstSeen = new Map<number, number>();
  for (const { chapter_number, date } of chapters) {
    const time = date?.getTime();
    if (time === undefined || !Number.isFinite(time)) continue;
    const previous = firstSeen.get(chapter_number);
    if (previous === undefined || time < previous) firstSeen.set(chapter_number, time);
  }
  const days = [...new Set([...firstSeen.values()].map((time) => Math.floor(time / DAY_MS)))]
    .sort((a, b) => a - b)
    .slice(-(RECENT_CHAPTERS + 1));
  if (days.length < MIN_GAPS + 1) return null;

  const gaps = days.slice(1).map((day, i) => day - days[i]);
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
  if (median > MAX_INTERVAL_DAYS) return null;
  const interval = Math.max(MIN_INTERVAL_DAYS, median);

  const last = Math.max(...firstSeen.values());
  const next = last + interval * DAY_MS;
  if (now - next > Math.max(STALLED_INTERVALS * interval, STALLED_MIN_DAYS) * DAY_MS) return null;
  return {
    interval_days: interval,
    next_expected_at: new Date(next),
    last_chapter_at: new Date(last),
  };
}
