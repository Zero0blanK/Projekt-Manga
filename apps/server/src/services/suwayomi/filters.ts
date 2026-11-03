import type { FilterValue, MangaFilter } from '@projekt-manga/types';

/**
 * Suwayomi's source filters (Mihon's `FilterList`) in this app's filter shape, and the
 * chosen values back as Suwayomi `FilterChange`s.
 *
 * A filter's key is its position in the source's list (`f3`), which is how Suwayomi
 * addresses a change. Headers and separators are labels only and are dropped. A group of
 * checkboxes becomes a multi-select and a group with tri-states a tri-state list, keyed by
 * the child's position in the group.
 */

export type SuwayomiFilter =
  | { __typename: 'HeaderFilter' | 'SeparatorFilter'; name: string }
  | { __typename: 'SelectFilter'; name: string; values: string[]; selectDefault: number }
  | { __typename: 'TextFilter'; name: string; textDefault: string }
  | { __typename: 'CheckBoxFilter'; name: string; checkDefault: boolean }
  | { __typename: 'TriStateFilter'; name: string; triDefault: TriState }
  | {
      __typename: 'SortFilter';
      name: string;
      values: string[];
      sortDefault: { index: number; ascending: boolean } | null;
    }
  | { __typename: 'GroupFilter'; name: string; filters: SuwayomiFilter[] };

type TriState = 'IGNORE' | 'INCLUDE' | 'EXCLUDE';

export interface SuwayomiFilterChange {
  position: number;
  selectState?: number;
  textState?: string;
  checkBoxState?: boolean;
  triState?: TriState;
  sortState?: { index: number; ascending: boolean };
  groupChange?: SuwayomiFilterChange;
}

const FILTER_FIELDS = `
  __typename
  ... on HeaderFilter { name }
  ... on SeparatorFilter { name }
  ... on SelectFilter { name values selectDefault: default }
  ... on TextFilter { name textDefault: default }
  ... on CheckBoxFilter { name checkDefault: default }
  ... on TriStateFilter { name triDefault: default }
  ... on SortFilter { name values sortDefault: default { index ascending } }
`;

/** The selection for a source's filters. `default` is aliased per type: the union members
 * declare it with different types, which GraphQL refuses to merge under one name. */
export const FILTERS_SELECTION = `filters {
  ${FILTER_FIELDS}
  ... on GroupFilter { name filters { ${FILTER_FIELDS} } }
}`;

const key = (position: number) => `f${position}`;

function groupKind(children: SuwayomiFilter[]): 'multi' | 'tri-state' | null {
  if (children.some((child) => child.__typename === 'TriStateFilter')) return 'tri-state';
  if (children.some((child) => child.__typename === 'CheckBoxFilter')) return 'multi';
  return null;
}

export function toMangaFilters(filters: SuwayomiFilter[]): MangaFilter[] {
  const out: MangaFilter[] = [];
  filters.forEach((filter, position) => {
    const label = filter.name || `Filter ${position + 1}`;
    switch (filter.__typename) {
      case 'SelectFilter':
        out.push({
          label,
          value: key(position),
          type: 'select',
          options: filter.values.map((value, index) => ({ label: value, value: String(index) })),
        });
        break;
      case 'TextFilter':
        out.push({ label, value: key(position), type: 'input' });
        break;
      case 'CheckBoxFilter':
        // The filter panel shows a checkbox as a one-pill group.
        out.push({
          label,
          value: key(position),
          type: 'checkbox',
          options: [{ label, value: '0' }],
        });
        break;
      case 'TriStateFilter':
        out.push({
          label,
          value: key(position),
          type: 'tri-state',
          options: [{ label, value: '0' }],
        });
        break;
      case 'SortFilter':
        out.push({
          label,
          value: key(position),
          type: 'select',
          options: filter.values.flatMap((value, index) => [
            { label: `${value} ↓`, value: `${index}:desc` },
            { label: `${value} ↑`, value: `${index}:asc` },
          ]),
        });
        break;
      case 'GroupFilter': {
        const kind = groupKind(filter.filters);
        if (!kind) break;
        out.push({
          label,
          value: key(position),
          type: kind,
          options: filter.filters.flatMap((child, index) =>
            child.__typename === 'CheckBoxFilter' || child.__typename === 'TriStateFilter'
              ? [{ label: child.name || `Option ${index + 1}`, value: String(index) }]
              : [],
          ),
        });
        break;
      }
    }
  });
  return out;
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function triSelection(value: FilterValue | undefined): { include: string[]; exclude: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { include: asStrings(value), exclude: [] };
  }
  return { include: asStrings(value.include), exclude: asStrings(value.exclude) };
}

function desiredTri(id: string, selection: { include: string[]; exclude: string[] }): TriState {
  if (selection.exclude.includes(id)) return 'EXCLUDE';
  if (selection.include.includes(id)) return 'INCLUDE';
  return 'IGNORE';
}

/** The chosen values as changes from the source's defaults. Values of the wrong type, or
 * out of range, are ignored rather than sent: Suwayomi throws on a mismatched change. */
export function toFilterChanges(
  filters: SuwayomiFilter[],
  values: Record<string, FilterValue> = {},
): SuwayomiFilterChange[] {
  const changes: SuwayomiFilterChange[] = [];
  filters.forEach((filter, position) => {
    const value = values[key(position)];
    if (value === undefined) return;
    switch (filter.__typename) {
      case 'SelectFilter': {
        const index = Number(value);
        if (Number.isInteger(index) && index >= 0 && index < filter.values.length) {
          if (index !== filter.selectDefault) changes.push({ position, selectState: index });
        }
        break;
      }
      case 'TextFilter':
        if (typeof value === 'string' && value !== filter.textDefault) {
          changes.push({ position, textState: value.slice(0, 500) });
        }
        break;
      case 'CheckBoxFilter': {
        const checked = value === true || asStrings(value).includes('0');
        if (checked !== filter.checkDefault) changes.push({ position, checkBoxState: checked });
        break;
      }
      case 'TriStateFilter': {
        const state = desiredTri('0', triSelection(value));
        if (state !== filter.triDefault) changes.push({ position, triState: state });
        break;
      }
      case 'SortFilter': {
        const match = typeof value === 'string' ? /^(\d+):(asc|desc)$/.exec(value) : null;
        if (!match) break;
        const index = Number(match[1]);
        const ascending = match[2] === 'asc';
        if (index >= filter.values.length) break;
        if (filter.sortDefault?.index === index && filter.sortDefault.ascending === ascending)
          break;
        changes.push({ position, sortState: { index, ascending } });
        break;
      }
      case 'GroupFilter': {
        const kind = groupKind(filter.filters);
        if (!kind) break;
        const selection =
          kind === 'multi' ? { include: asStrings(value), exclude: [] } : triSelection(value);
        filter.filters.forEach((child, index) => {
          const state = desiredTri(String(index), selection);
          if (child.__typename === 'CheckBoxFilter') {
            const checked = state === 'INCLUDE';
            if (checked !== child.checkDefault) {
              changes.push({ position, groupChange: { position: index, checkBoxState: checked } });
            }
          } else if (child.__typename === 'TriStateFilter' && state !== child.triDefault) {
            changes.push({ position, groupChange: { position: index, triState: state } });
          }
        });
        break;
      }
    }
  });
  return changes;
}
