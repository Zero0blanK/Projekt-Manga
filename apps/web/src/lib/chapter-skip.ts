/**
 * Settings › Reader › Skip read chapters: moving to the next or previous chapter (by
 * button, key or auto-advance) passes over chapters already read. Duplicates need no rule
 * of their own, since the reader moves by chapter number and one number is one stop.
 */
export const SKIP_READ_CHAPTERS = 'readerSkipReadChapters';

/**
 * The chapter number after (`direction` 1) or before (-1) `current` in `sorted`, passing
 * over numbers `skip` says to. When every chapter that way is skipped, the immediate
 * neighbour is returned instead, so re-reading a finished series still moves on.
 */
export function adjacentChapter(
  sorted: readonly number[],
  current: number,
  direction: 1 | -1,
  skip: (chapterNumber: number) => boolean = () => false,
): number | null {
  const candidates =
    direction === 1
      ? sorted.filter((n) => n > current)
      : sorted.filter((n) => n < current).reverse();
  if (candidates.length === 0) return null;
  return candidates.find((n) => !skip(n)) ?? candidates[0];
}

/**
 * Settings › Reader › Skip duplicate chapters. Off (the default, as in Mihon): when
 * several scanlation groups released the same chapter, next and previous chapter visit
 * each group's release in turn. On: one stop per chapter number, in the preferred group's
 * release where there is one.
 *
 * Either way a group never gets two stops for one chapter number: a source listing the
 * same group's chapter twice (a re-upload, a fixed version) is one release.
 */
export const SKIP_DUPLICATE_CHAPTERS = 'readerSkipDuplicateChapters';

type Release = { id: string; chapter_number: number; scanlator?: string | null };

const groupOf = (release: Release) => release.scanlator?.trim().toLowerCase() || '';

/**
 * Every release worth a stop, in reading order: by chapter number, then the preferred
 * group first and the rest by name. Of a group's copies of one number, the first listed
 * is kept, unless `keep` names one of them (the release being read).
 */
export function releaseStops<T extends Release>(
  releases: readonly T[],
  preferredGroup = '',
  keep?: string,
): T[] {
  const preferred = preferredGroup.trim().toLowerCase();
  const byKey = new Map<string, T>();
  for (const release of releases) {
    const key = `${release.chapter_number} ${groupOf(release)}`;
    if (!byKey.has(key) || release.id === keep) byKey.set(key, release);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.chapter_number - b.chapter_number ||
      Number(groupOf(b) === preferred) - Number(groupOf(a) === preferred) ||
      groupOf(a).localeCompare(groupOf(b)),
  );
}

/**
 * The release after (1) or before (-1) `current` among `stops`, passing over ones `skip`
 * says to, with the same fallback to the immediate neighbour as {@link adjacentChapter}.
 * `current` may be a duplicate that isn't a stop itself; its group's stop stands in.
 */
export function adjacentRelease<T extends Release>(
  stops: readonly T[],
  current: Release,
  direction: 1 | -1,
  skip: (release: T) => boolean = () => false,
): T | null {
  let index = stops.findIndex((stop) => stop.id === current.id);
  if (index === -1)
    index = stops.findIndex(
      (stop) =>
        stop.chapter_number === current.chapter_number && groupOf(stop) === groupOf(current),
    );
  if (index === -1) return null;
  const candidates = direction === 1 ? stops.slice(index + 1) : stops.slice(0, index).reverse();
  if (candidates.length === 0) return null;
  return candidates.find((stop) => !skip(stop)) ?? candidates[0];
}
