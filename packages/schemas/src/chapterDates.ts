/**
 * Release dates that a source left stuck to the end of a chapter's name.
 *
 * Some sites put the date inside the chapter's link, so a source reading the link's text
 * gets "Chapter 1032 weeks ago" or "Chapter 101Oct 14, 2026", with no date of its own and
 * a chapter number read from the run-together digits (1032). This takes the date back off
 * the name, gives it to the chapter as its release date, and puts the number right.
 *
 * Run-together digits are ambiguous ("1032 weeks" is 103 + 2 or 10 + 32): a split is kept
 * only when its amount is one a site would show (2 weeks, not 32), and when several are
 * left, the one whose chapter number sits closest to its neighbours' wins.
 *
 * Only chapters without a release date are touched, so a source that dates its chapters
 * keeps its names exactly as sent.
 */

interface ChapterLike {
  name?: string;
  chapter_number: number;
  release_date?: string;
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
const MONTH_NAME =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const monthIndex = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase() as never);

const UNIT_MS = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
} as const;
type Unit = keyof typeof UNIT_MS;
/** The largest amount of each unit a site shows before moving to the next unit. */
const MOST: Record<Unit, number> = {
  second: 59,
  minute: 59,
  hour: 23,
  day: 31,
  week: 8,
  month: 24,
  year: 40,
};
const UNIT_ALIASES: Record<string, Unit> = {
  s: 'second',
  sec: 'second',
  second: 'second',
  min: 'minute',
  minute: 'minute',
  h: 'hour',
  hr: 'hour',
  hour: 'hour',
  d: 'day',
  day: 'day',
  w: 'week',
  wk: 'week',
  week: 'week',
  mo: 'month',
  month: 'month',
  y: 'year',
  yr: 'year',
  year: 'year',
};

/** One reading of a name: the name without its date, and the date. */
export interface ChapterDateSplit {
  name: string;
  date: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const utcDate = (year: number, month: number, day: number) =>
  month >= 0 && month < 12 && day >= 1 && day <= 31 ? iso(Date.UTC(year, month, day)) : '';

/**
 * A relative date only as exact as it was said ("2 weeks ago" is a day, not a millisecond),
 * so reading the same list again later gives the same date and the chapter isn't re-saved.
 */
const roughly = (ms: number, unit: Unit) => {
  const step = Math.min(UNIT_MS[unit], UNIT_MS.day);
  return iso(Math.floor(ms / step) * step);
};

/** What is left of a name once its date is gone: no trailing separators or spaces. */
const tidy = (prefix: string) => prefix.replace(/[\s\-–—|·•,:]+$/u, '');

/**
 * Every way to split a date off the end of `name`, most likely first. Several only when
 * the date starts with digits run into the chapter number's.
 */
export function chapterDateSplits(name: string, now = Date.now()): ChapterDateSplit[] {
  const text = name.replace(/\s/g, ' ').trim();
  const splits: ChapterDateSplit[] = [];
  const add = (prefix: string, date: string, needsNumber = false) => {
    const left = tidy(prefix);
    if (!date || !left) return;
    // A word on its own ("today", "last week") could be the title's; only taken from right
    // after the chapter's number.
    if (needsNumber && !/\d\s*$/.test(prefix)) return;
    splits.push({ name: left, date });
  };
  /** Each split of run-together leading digits: the date's share, shortest first. */
  const leading = (before: string, digits: string, most: number, make: (n: number) => string) => {
    for (let take = 1; take <= digits.length; take++) {
      const amount = Number(digits.slice(-take));
      if (amount < 1 || amount > most || (take > 1 && digits.at(-take) === '0')) continue;
      add(before + digits.slice(0, -take), make(amount));
    }
  };

  // "2 weeks ago", "an hour ago", "3d ago"
  let match = /(\d+|an?|one)\s*([a-z]+?)s?\s+ago$/i.exec(text);
  const unit = match && UNIT_ALIASES[match[2].toLowerCase()];
  if (match && unit) {
    const before = text.slice(0, match.index);
    const ago = (n: number) => roughly(now - n * UNIT_MS[unit], unit);
    if (/^\d+$/.test(match[1])) leading(before, match[1], MOST[unit], ago);
    else add(before, ago(1));
    return splits;
  }

  // "Just now", "today", "yesterday", "last week"
  match = /(just now|now|today|yesterday|last (week|month|year))$/i.exec(text);
  if (match) {
    const word = match[1].toLowerCase();
    const back =
      word === 'yesterday' ? UNIT_MS.day : match[2] ? UNIT_MS[match[2].toLowerCase() as Unit] : 0;
    add(text.slice(0, match.index), roughly(now - back, back ? 'day' : 'minute'), true);
    return splits;
  }

  // "Oct 14, 2026", "October 14 2026"
  match = new RegExp(`${MONTH_NAME}\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})$`, 'i').exec(text);
  if (match) {
    add(
      text.slice(0, match.index),
      utcDate(Number(match[3]), monthIndex(match[1]), Number(match[2])),
    );
    return splits;
  }

  // "14 Oct 2026", "14 October, 2026"
  match = new RegExp(`(\\d+)\\s*${MONTH_NAME},?\\s*(\\d{4})$`, 'i').exec(text);
  if (match) {
    const [, digits, month, year] = match;
    leading(text.slice(0, match.index), digits, 31, (day) =>
      utcDate(Number(year), monthIndex(month), day),
    );
    return splits;
  }

  // "2026-10-14"
  match = /(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) {
    add(
      text.slice(0, match.index),
      utcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    );
    return splits;
  }

  // "10/14/2026" (or day first, when the first part can't be a month)
  match = /(\d+)\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) {
    const [, digits, second, year] = match;
    leading(text.slice(0, match.index), digits, 31, (first) =>
      first <= 12
        ? utcDate(Number(year), first - 1, Number(second))
        : utcDate(Number(year), Number(second) - 1, first),
    );
  }
  return splits;
}

/** The last number in a name, as the chapter number it gives. */
function numberIn(name: string): number | null {
  const all = name.match(/\d+(?:\.\d+)?/g);
  return all ? Number(all.at(-1)) : null;
}

/**
 * The chapters with dates taken off their names, as described at the top. The list is
 * returned as is (the same array) when no chapter needed it.
 */
export function separateChapterDates<T extends ChapterLike>(chapters: T[], now = Date.now()): T[] {
  const options = chapters.map((chapter) =>
    chapter.release_date || !chapter.name ? [] : chapterDateSplits(chapter.name, now),
  );
  if (options.every((splits) => splits.length === 0)) return chapters;

  // The numbers already known: chapters with no date in their name, and the ones with only
  // one way to read it.
  const known: (number | null)[] = chapters.map((chapter, index) =>
    options[index].length === 0
      ? chapter.chapter_number
      : options[index].length === 1
        ? numberIn(options[index][0].name)
        : null,
  );
  const nearestKnown = (index: number) => {
    for (let step = 1; step < chapters.length; step++) {
      const around = [known[index - step], known[index + step]].filter(
        (n): n is number => typeof n === 'number',
      );
      if (around.length > 0) return around;
    }
    return [];
  };

  return chapters.map((chapter, index) => {
    const splits = options[index];
    if (splits.length === 0) return chapter;
    let chosen = splits[0];
    if (splits.length > 1) {
      const around = nearestKnown(index);
      const distance = (split: ChapterDateSplit) => {
        const n = numberIn(split.name);
        return n === null || around.length === 0
          ? Infinity
          : Math.min(...around.map((other) => Math.abs(other - n)));
      };
      chosen = splits.reduce((best, split) => (distance(split) < distance(best) ? split : best));
      known[index] = numberIn(chosen.name);
    }
    // The source read its number off the run-together text ("1032" for chapter 103).
    const cleanNumber = numberIn(chosen.name);
    const sentNumber = String(chapter.chapter_number);
    const chapter_number =
      cleanNumber !== null &&
      cleanNumber !== chapter.chapter_number &&
      sentNumber.startsWith(String(cleanNumber))
        ? cleanNumber
        : chapter.chapter_number;
    return { ...chapter, name: chosen.name, release_date: chosen.date, chapter_number };
  });
}
