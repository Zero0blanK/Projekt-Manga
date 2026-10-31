/** Settings › Sync & Storage › Library updates, per category. Both are JSON strings,
 * because settings hold primitives only. */
export const CATEGORY_UPDATE_SETTING = {
  /** `{ [category]: hours }` — how often titles in that category are checked. */
  intervals: 'updateCategoryIntervalHours',
  /** Categories whose new chapters never raise a notification. */
  mutedCategories: 'updateMutedCategories',
} as const;

export const MIN_UPDATE_INTERVAL_HOURS = 1;
export const MAX_UPDATE_INTERVAL_HOURS = 168;

/** Clamp a stored interval to the supported range, or null when it isn't a usable number. */
export function clampIntervalHours(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(MIN_UPDATE_INTERVAL_HOURS, Math.min(value, MAX_UPDATE_INTERVAL_HOURS));
}

/** A stored category interval map, tolerating anything malformed as "none". */
export function parseCategoryIntervals(raw: unknown): Record<string, number> {
  if (typeof raw !== 'string' || !raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [name, hours] of Object.entries(value as Record<string, unknown>)) {
    const clamped = clampIntervalHours(hours);
    if (clamped !== null) out[name] = clamped;
  }
  return out;
}

/** The stored muted-category list. Same format as the include/exclude lists in
 * `library-update.ts`; kept here so the scheduler doesn't depend on that module. */
export function parseMutedCategories(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string')
      : [];
  } catch {
    return [];
  }
}

type Members = Readonly<Record<string, readonly string[] | undefined>> | undefined;

/**
 * How often a title is checked. A title in categories that set an interval uses the
 * shortest of them; otherwise the global interval. A source's own minimum always wins,
 * because it exists to keep a source from being hit more often than it tolerates.
 */
export function resolveUpdateIntervalHours(
  mangaId: string,
  options: {
    globalHours: number;
    sourceMinimumHours?: number | null;
    categoryIntervals: Readonly<Record<string, number>>;
    categoryMembers: Members;
  },
): number {
  const globalHours = clampIntervalHours(options.globalHours) ?? 12;
  let categoryHours: number | null = null;
  for (const [name, hours] of Object.entries(options.categoryIntervals)) {
    const clamped = clampIntervalHours(hours);
    if (clamped === null || !options.categoryMembers?.[name]?.includes(mangaId)) continue;
    categoryHours = categoryHours === null ? clamped : Math.min(categoryHours, clamped);
  }
  const minimum = clampIntervalHours(options.sourceMinimumHours) ?? MIN_UPDATE_INTERVAL_HOURS;
  return Math.max(categoryHours ?? globalHours, minimum);
}

/** Whether new chapters for this title stay silent: it's in at least one muted category. */
export function isNotificationMuted(
  mangaId: string,
  mutedCategories: readonly string[],
  categoryMembers: Members,
): boolean {
  return mutedCategories.some((name) => categoryMembers?.[name]?.includes(mangaId));
}

export type UpdateBucket<T> = { source: string; intervalHours: number; entries: T[] };

/**
 * Groups entries into schedule buckets: one per source and interval. A bucket on the
 * source's default interval keeps the plain source as its key, so last-checked times
 * stored before category intervals existed still apply.
 */
export function updateBuckets<T extends { id: string; source: string }>(
  entries: readonly T[],
  options: {
    globalHours: number;
    sourceMinimumHours: (source: string) => number | null;
    categoryIntervals: Readonly<Record<string, number>>;
    categoryMembers: Members;
  },
): Map<string, UpdateBucket<T>> {
  const buckets = new Map<string, UpdateBucket<T>>();
  for (const entry of entries) {
    const sourceMinimumHours = options.sourceMinimumHours(entry.source);
    const intervalHours = resolveUpdateIntervalHours(entry.id, { ...options, sourceMinimumHours });
    const defaultHours = resolveUpdateIntervalHours(entry.id, {
      globalHours: options.globalHours,
      sourceMinimumHours,
      categoryIntervals: {},
      categoryMembers: undefined,
    });
    const key = intervalHours === defaultHours ? entry.source : `${entry.source}@${intervalHours}h`;
    const bucket = buckets.get(key);
    if (bucket) bucket.entries.push(entry);
    else buckets.set(key, { source: entry.source, intervalHours, entries: [entry] });
  }
  return buckets;
}

/** The titles with new chapters that should be announced, by id, leaving out muted titles
 * and sources: what the alerts outside the app list. */
export function notifiableTitles(
  foundByManga: Readonly<Record<string, number>>,
  options: {
    sourceOf: (mangaId: string) => string | undefined;
    sourceNotifies: (source: string) => boolean;
    mutedCategories: readonly string[];
    categoryMembers: Members;
  },
): Array<[mangaId: string, count: number]> {
  return Object.entries(foundByManga).filter(([mangaId, count]) => {
    if (count <= 0) return false;
    const source = options.sourceOf(mangaId);
    if (source !== undefined && !options.sourceNotifies(source)) return false;
    return !isNotificationMuted(mangaId, options.mutedCategories, options.categoryMembers);
  });
}

/** New chapters that should be announced, leaving out muted titles and sources. */
export function notifiableNewChapters(
  foundByManga: Readonly<Record<string, number>>,
  options: {
    sourceOf: (mangaId: string) => string | undefined;
    sourceNotifies: (source: string) => boolean;
    mutedCategories: readonly string[];
    categoryMembers: Members;
  },
): number {
  let total = 0;
  for (const [mangaId, count] of Object.entries(foundByManga)) {
    const source = options.sourceOf(mangaId);
    if (source !== undefined && !options.sourceNotifies(source)) continue;
    if (isNotificationMuted(mangaId, options.mutedCategories, options.categoryMembers)) continue;
    total += count;
  }
  return total;
}

/**
 * What goes to the outside-the-app alert channels (ntfy, Discord, Telegram, webhook) for
 * one library update, scheduled or started by hand: the announced titles with their new
 * chapter counts, within the server's limits (200 titles, 200-character names).
 */
export function chapterAlertTitles(
  foundByManga: Readonly<Record<string, number>>,
  titleOf: (mangaId: string) => string | undefined,
  options: Parameters<typeof notifiableTitles>[1],
): Array<{ title: string; count: number }> {
  return notifiableTitles(foundByManga, options)
    .map(([mangaId, count]) => ({
      title: (titleOf(mangaId) ?? 'A title').trim().slice(0, 200) || 'A title',
      count: Math.min(count, 10_000),
    }))
    .slice(0, 200);
}
