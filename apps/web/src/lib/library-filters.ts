import type { Manga } from '@/lib/manga-data';

/** Filters that combine with the shelf and category pills. Empty lists filter nothing. */
export type LibraryFilters = {
  statuses: Manga['status'][];
  includeTags: string[];
  excludeTags: string[];
};

export const NO_LIBRARY_FILTERS: LibraryFilters = {
  statuses: [],
  includeTags: [],
  excludeTags: [],
};

export const LIBRARY_STATUSES: Manga['status'][] = [
  'Ongoing',
  'Completed',
  'Hiatus',
  'Cancelled',
  'Unknown',
];

const MAX_TAGS = 100;

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_TAGS)
    : [];

export function parseLibraryFilters(raw: unknown): LibraryFilters {
  if (!raw || typeof raw !== 'object') return NO_LIBRARY_FILTERS;
  const { statuses, includeTags, excludeTags } = raw as Record<string, unknown>;
  return {
    statuses: strings(statuses).filter((status): status is Manga['status'] =>
      (LIBRARY_STATUSES as string[]).includes(status),
    ),
    includeTags: strings(includeTags),
    excludeTags: strings(excludeTags),
  };
}

export const libraryFilterCount = (filters: LibraryFilters) =>
  filters.statuses.length + filters.includeTags.length + filters.excludeTags.length;

const normal = (tag: string) => tag.trim().toLowerCase();

/** A title must carry every included tag and none of the excluded ones. Sources spell tags
 * differently, so they're compared without regard to case. */
export function passesLibraryFilters(
  manga: Pick<Manga, 'status' | 'tags'>,
  filters: LibraryFilters,
): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes(manga.status)) return false;
  if (filters.includeTags.length === 0 && filters.excludeTags.length === 0) return true;
  const tags = new Set(manga.tags.map(normal));
  return (
    filters.includeTags.every((tag) => tags.has(normal(tag))) &&
    !filters.excludeTags.some((tag) => tags.has(normal(tag)))
  );
}

/** Every tag in the library, most used first, each in its commonest spelling. */
export function libraryTags(library: Array<Pick<Manga, 'tags'>>): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const { tags } of library) {
    for (const tag of new Set(tags)) {
      if (!tag.trim()) continue;
      const key = normal(tag);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { label: tag.trim(), count: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map(({ label }) => label);
}

/** Off → must have → must not have → off. */
export function cycleTag(filters: LibraryFilters, tag: string): LibraryFilters {
  const without = (list: string[]) => list.filter((entry) => entry !== tag);
  if (filters.includeTags.includes(tag)) {
    return {
      ...filters,
      includeTags: without(filters.includeTags),
      excludeTags: [...filters.excludeTags, tag],
    };
  }
  if (filters.excludeTags.includes(tag)) {
    return { ...filters, excludeTags: without(filters.excludeTags) };
  }
  return { ...filters, includeTags: [...filters.includeTags, tag] };
}
