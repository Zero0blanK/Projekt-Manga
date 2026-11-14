import type { FilterValue, MangaFilter, TriStateFilterValue } from '@projekt-manga/types';

/**
 * The shape a source's filter selections are held in, and the one derived value both
 * the panel and the browse page need from it.
 *
 * Lives here rather than in filter-panel.tsx because it is shared logic, not part of a
 * component — the panel renders the filters, the browse page only wants the badge count.
 */

export type FilterValues = Record<string, FilterValue>;

/** A tri-state filter (include/exclude lists) rather than a plain value. */
export function isTriState(v: FilterValue | undefined): v is TriStateFilterValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** How many filters currently have a real, non-empty selection — for a badge count. */
export function countActiveFilters(values: FilterValues): number {
  return Object.values(values).filter((v) => {
    if (v === undefined || v === '' || v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (isTriState(v)) return (v.include?.length ?? 0) > 0 || (v.exclude?.length ?? 0) > 0;
    return true;
  }).length;
}

const comparable = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The selection that asks a source for one genre, from that source's own filters: the
 * option labelled like the genre (letter case, spaces and dashes aside), preferring a field
 * named like genres or tags. Null when the source has no such option.
 */
export function genreFilterValues(
  filters: readonly MangaFilter[],
  genre: string,
): FilterValues | null {
  const wanted = comparable(genre);
  if (!wanted) return null;
  const isGenreField = (field: MangaFilter) => /genre|tag|categor/i.test(field.label + field.value);
  const fields = [...filters.filter(isGenreField), ...filters.filter((f) => !isGenreField(f))];
  for (const field of fields) {
    const option = field.options?.find(
      (o) => comparable(o.label) === wanted || comparable(o.value) === wanted,
    );
    if (!option) continue;
    switch (field.type) {
      case 'tri-state':
        return { [field.value]: { include: [option.value] } };
      case 'multi':
      case 'checkbox':
        return { [field.value]: [option.value] };
      case 'select':
      case 'radio':
        // A single-choice field named like genres; any other one (a sort, a status) holding
        // a same-named option is not a genre filter.
        if (isGenreField(field)) return { [field.value]: option.value };
    }
  }
  return null;
}
