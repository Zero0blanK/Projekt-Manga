import { useMemo } from 'react';
import type { Manga } from '@/lib/manga-data';
import { useAppState, useSetting, type ShelfStatus } from '@/lib/app-store';

/** Statuses that mean no further chapters are coming, so a library update has nothing to
 * find. Matches the values `Manga["status"]` can hold. */
const FINISHED_STATUSES = new Set(['Completed', 'Cancelled']);

/** Settings › Library › Library updates. Category lists are stored as JSON
 * strings, because settings hold primitives only. */
export const UPDATE_SETTING = {
  skipCompleted: 'skipCompletedOnUpdate',
  skipUnread: 'skipUnreadOnUpdate',
  skipNotStarted: 'skipNotStartedOnUpdate',
  includeCategories: 'updateIncludeCategories',
  excludeCategories: 'updateExcludeCategories',
  smartUpdate: 'smartLibraryUpdate',
} as const;

export type GlobalUpdateRules = {
  skipCompleted: boolean;
  /** Skip titles that still have unread chapters: new ones would only pile up. */
  skipUnread: boolean;
  /** Skip titles never opened. */
  skipNotStarted: boolean;
  /** When non-empty, only titles in one of these categories are checked. */
  includeCategories: string[];
  /** Titles in any of these are never checked; this wins over the include list. */
  excludeCategories: string[];
  categoryMembers: Record<string, string[]>;
};

export const NO_UPDATE_RULES: GlobalUpdateRules = {
  skipCompleted: false,
  skipUnread: false,
  skipNotStarted: false,
  includeCategories: [],
  excludeCategories: [],
  categoryMembers: {},
};

/** A stored category list, tolerating anything malformed as "none". */
export function parseCategoryList(raw: unknown): string[] {
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

/** The library update rules from settings, for the button, the scheduler and Statistics. */
export function useGlobalUpdateRules(): GlobalUpdateRules {
  const skipCompleted = useSetting(UPDATE_SETTING.skipCompleted, false) as boolean;
  const skipUnread = useSetting(UPDATE_SETTING.skipUnread, false) as boolean;
  const skipNotStarted = useSetting(UPDATE_SETTING.skipNotStarted, false) as boolean;
  const include = useSetting(UPDATE_SETTING.includeCategories, '');
  const exclude = useSetting(UPDATE_SETTING.excludeCategories, '');
  const categoryMembers = useAppState((state) => state.categoryMembers);
  return useMemo(
    () => ({
      skipCompleted,
      skipUnread,
      skipNotStarted,
      includeCategories: parseCategoryList(include),
      excludeCategories: parseCategoryList(exclude),
      categoryMembers,
    }),
    [skipCompleted, skipUnread, skipNotStarted, include, exclude, categoryMembers],
  );
}

const inAny = (mangaId: string, names: string[], members: Record<string, string[]>) =>
  names.some((name) => members[name]?.includes(mangaId));

/** Whether the title has chapters it hasn't read. */
export function hasUnread(manga: Manga): boolean {
  return manga.chapters > 0 && (manga.progress ?? 0) < 1;
}

/**
 * Whether a library entry is included in a library update run — the set the Update
 * Library button walks, and the number Settings > Statistics reports as "in global
 * update". Both read this so the count can never describe something the button doesn't do.
 */
export function isInGlobalUpdate(
  manga: Manga,
  shelf: Partial<Record<string, ShelfStatus>>,
  rules: GlobalUpdateRules,
): boolean {
  const { categoryMembers: members } = rules;
  if (inAny(manga.id, rules.excludeCategories, members)) return false;
  if (rules.includeCategories.length > 0 && !inAny(manga.id, rules.includeCategories, members))
    return false;
  if (
    rules.skipCompleted &&
    (shelf[manga.id] === 'completed' || FINISHED_STATUSES.has(manga.status))
  )
    return false;
  if (rules.skipNotStarted && !((manga.progress ?? 0) > 0)) return false;
  if (rules.skipUnread && hasUnread(manga)) return false;
  return true;
}

export function entriesInGlobalUpdate(
  manga: Manga[],
  shelf: Partial<Record<string, ShelfStatus>>,
  rules: GlobalUpdateRules,
): Manga[] {
  return manga.filter((m) => isInGlobalUpdate(m, shelf, rules));
}

/** How long before a title's expected release a scheduled update starts checking it. */
const SMART_UPDATE_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Smart update: a scheduled run leaves out titles whose next chapter isn't expected for
 * more than a day. Titles without an estimate are always checked, as is everything when
 * the estimates couldn't be loaded.
 */
export function dueForSmartUpdate(
  entries: Manga[],
  estimates: ReadonlyMap<string, string> | null,
  now = Date.now(),
): Manga[] {
  if (!estimates) return entries;
  return entries.filter((entry) => {
    const next = estimates.get(entry.id);
    const at = next ? Date.parse(next) : NaN;
    return !Number.isFinite(at) || at - now <= SMART_UPDATE_MARGIN_MS;
  });
}

/** Entries that have been opened but not finished — at least one chapter read, with
 * chapters still to go. */
export function isStarted(manga: Manga): boolean {
  const progress = manga.progress ?? 0;
  return progress > 0 && progress < 1;
}
