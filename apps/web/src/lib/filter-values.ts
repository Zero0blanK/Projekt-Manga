import type { FilterValue, TriStateFilterValue } from '@projekt-manga/types';

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
