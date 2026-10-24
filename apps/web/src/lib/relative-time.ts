/**
 * Time formatting for "how recently did this happen" questions.
 *
 * `toLocaleString()` answers a different question. "10/17/2026, 1:11:14 PM" is the right
 * format for a timestamp someone has to record or compare precisely, and the wrong one for
 * judging whether a source is healthy — that needs a diff against now, which the reader
 * would otherwise do in their head on every row. Source health, sync status and update
 * logs all ask the recency question.
 *
 * Both are kept: `relativeTime` for the label, `absoluteTime` for the `title` tooltip, so
 * precision is one hover away rather than gone.
 */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/** Below this, "just now" reads better than "0 seconds ago" or "in -3 seconds". */
const JUST_NOW_MS = 45 * 1000;

function formatter(): Intl.RelativeTimeFormat {
  // Constructed per call rather than cached at module scope: a cached instance captures
  // the locale at import time, and the settings panel can change language mid-session.
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
}

/**
 * "4 minutes ago", "in 2 hours", "just now" — or null when there is no usable date, so
 * callers phrase the absence themselves ("never checked" and "unknown" are not the same
 * thing, and this has no way to tell which applies).
 */
export function relativeTime(
  value: string | Date | null | undefined,
  now = Date.now(),
): string | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(time)) return null;

  const delta = time - now;
  if (Math.abs(delta) < JUST_NOW_MS) return 'just now';

  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) {
      return formatter().format(Math.round(delta / ms), unit);
    }
  }
  return formatter().format(Math.round(delta / 1000), 'second');
}

/** The full timestamp, for a `title` tooltip beside a relative label. */
export function absoluteTime(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

/** Seconds remaining, phrased for a cooldown that the reader is waiting out. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}
