import { useEffect, useSyncExternalStore } from 'react';
import { APP_STATE_STORAGE_KEY } from '@/lib/theme';

/* ------------------------------------------------------------------ types */

export type ShelfStatus = 'reading' | 'completed' | 'on-hold' | 'plan' | 'dropped';

export const SHELF_OPTIONS: Array<{ value: ShelfStatus; label: string }> = [
  { value: 'reading', label: 'Reading' },
  { value: 'completed', label: 'Completed' },
  { value: 'on-hold', label: 'On Hold' },
  { value: 'plan', label: 'Plan to Read' },
  { value: 'dropped', label: 'Dropped' },
];

/** Shared with the Settings > Reader panel's "Page layout" select. */
export const PAGE_LAYOUTS = ['Two-page spread', 'Single page', 'Long strip'] as const;
export type PageLayout = (typeof PAGE_LAYOUTS)[number];

/** Every persisted preference value. Numbers are kept as numbers rather than stringified
 * so sliders (reader brightness) and counters (pages to preload) round-trip cleanly. */
export type SettingValue = string | boolean | number;

export type AppState = {
  settings: Record<string, SettingValue>;
  view: 'grid' | 'list';
  sort: 'latest' | 'title' | 'rating' | 'progress' | 'lastRead';
  sortDir: 'asc' | 'desc';
  /** User-created library categories, e.g. "Favorites". */
  customCategories: string[];
  /** Category name -> manga ids in it. */
  categoryMembers: Record<string, string[]>;
};

const initial: AppState = {
  settings: {},
  view: 'grid',
  sort: 'latest',
  sortDir: 'desc',
  customCategories: [],
  categoryMembers: {},
};

/* ------------------------------------------------------------------ store */

const KEY = APP_STATE_STORAGE_KEY;
let state: AppState = initial;
let hydrated = false;
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    /* storage unavailable — keep in memory */
    return false;
  }
}

function emit() {
  listeners.forEach((l) => l());
}

/**
 * Keeps only the fields that are the right *shape*, not merely present.
 *
 * A corrupt-but-parseable value (`categoryMembers: "x"` from a half-written write or an
 * older build) would otherwise land in state and throw later, far from the cause, the
 * first time something called `Object.entries` or `.includes` on it.
 */
function sanitizeStoredState(parsed: unknown): Partial<AppState> {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const raw = parsed as Record<string, unknown>;
  const out: Partial<AppState> = {};

  if (typeof raw.settings === 'object' && raw.settings !== null && !Array.isArray(raw.settings)) {
    out.settings = raw.settings as AppState['settings'];
  }
  if (raw.view === 'grid' || raw.view === 'list') out.view = raw.view;
  if (typeof raw.sort === 'string') out.sort = raw.sort as AppState['sort'];
  if (raw.sortDir === 'asc' || raw.sortDir === 'desc') out.sortDir = raw.sortDir;
  if (
    Array.isArray(raw.customCategories) &&
    raw.customCategories.every((c) => typeof c === 'string')
  ) {
    out.customCategories = raw.customCategories as string[];
  }
  if (
    typeof raw.categoryMembers === 'object' &&
    raw.categoryMembers !== null &&
    !Array.isArray(raw.categoryMembers)
  ) {
    const members: Record<string, string[]> = {};
    for (const [name, ids] of Object.entries(raw.categoryMembers as Record<string, unknown>)) {
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
        members[name] = ids as string[];
      }
    }
    out.categoryMembers = members;
  }

  return out;
}

function hydrate() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = { ...initial, ...sanitizeStoredState(JSON.parse(raw)) };
  } catch {
    /* ignore corrupt state */
  }
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  const persisted = persist();
  emit();
  return persisted;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** SSR renders the default state; the client swaps in persisted state after mount. */
export function useAppState<T>(select: (s: AppState) => T): T {
  const value = useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(initial),
  );
  useEffect(() => {
    if (hydrated) return;
    hydrate();
    emit();
  }, []);
  return value;
}

/* ---------------------------------------------------------------- actions */

export const actions = {
  setSetting(key: string, value: SettingValue) {
    return setState((s) => ({ settings: { ...s.settings, [key]: value } }));
  },
  setView(view: AppState['view']) {
    setState({ view });
  },
  setSort(sort: AppState['sort']) {
    setState({ sort });
  },
  setSortDir(sortDir: AppState['sortDir']) {
    setState({ sortDir });
  },
  addCategory(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((s) =>
      s.customCategories.includes(trimmed)
        ? {}
        : { customCategories: [...s.customCategories, trimmed] },
    );
  },
  removeCategory(name: string) {
    setState((s) => {
      const categoryMembers = { ...s.categoryMembers };
      delete categoryMembers[name];
      return {
        customCategories: s.customCategories.filter((c) => c !== name),
        categoryMembers,
      };
    });
  },
  renameCategory(name: string, nextName: string) {
    const trimmed = nextName.trim();
    setState((s) => {
      if (!trimmed || trimmed === name) return {};
      if (s.customCategories.includes(trimmed)) return {};
      const categoryMembers = { ...s.categoryMembers };
      categoryMembers[trimmed] = categoryMembers[name] ?? [];
      delete categoryMembers[name];
      return {
        customCategories: s.customCategories.map((c) => (c === name ? trimmed : c)),
        categoryMembers,
      };
    });
  },
  toggleCategoryMember(category: string, mangaId: string) {
    setState((s) => {
      const list = s.categoryMembers[category] ?? [];
      return {
        categoryMembers: {
          ...s.categoryMembers,
          [category]: list.includes(mangaId)
            ? list.filter((id) => id !== mangaId)
            : [...list, mangaId],
        },
      };
    });
  },
  resetAll() {
    state = initial;
    persist();
    emit();
  },
};

export function useSetting(key: string, fallback: SettingValue) {
  const value = useAppState((s) => s.settings[key]);
  return value === undefined ? fallback : value;
}

/** The whole state, for callers outside React (see lib/migrate-manga.ts). Hydrates from
 * storage first, exactly like getSetting — reading before that has happened would report
 * the empty initial state as though the reader had no categories. */
export function getAppState(): AppState {
  hydrate();
  return state;
}

/** Reads a setting outside React, for module-level code that has no hook context.
 * Hydrates on first use so it never reports a default over a persisted value. */
export function getSetting(key: string, fallback: SettingValue): SettingValue {
  hydrate();
  const value = state.settings[key];
  return value === undefined ? fallback : value;
}

/** A setting read back as a number, with the fallback used for anything unparseable —
 * covers values persisted as strings by an earlier build of the same setting. */
export function useNumberSetting(key: string, fallback: number): number {
  const raw = useSetting(key, fallback);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Removes a single setting so it falls back to its default again. */
export function clearSetting(key: string) {
  setState((s) => {
    const settings = { ...s.settings };
    delete settings[key];
    return { settings };
  });
}
