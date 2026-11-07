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
  /** Library display: covers with titles below, covers with titles on them, or rows. */
  view: 'grid' | 'compact' | 'list';
  sort: 'latest' | 'title' | 'rating' | 'progress' | 'lastRead';
  sortDir: 'asc' | 'desc';
  /** The current identity's library categories, e.g. "Favorites". They live on the server
   * (see lib/category-sync.ts): this is what's on screen, and it's never stored here. */
  customCategories: string[];
  /** Category name -> manga ids in it. */
  categoryMembers: Record<string, string[]>;
  /** Categories an older version kept in this browser, until they reach the server. */
  pendingCategoryImport?: LocalCategories;
};

type LocalCategories = Pick<AppState, 'customCategories' | 'categoryMembers'>;

/** Where category edits go; set by lib/category-sync.ts. */
type CategoryBackend = {
  add(name: string): void;
  remove(name: string): void;
  rename(name: string, nextName: string): void;
  setMember(name: string, mangaId: string, member: boolean): void;
  merge(categories: Array<{ name: string; ids: string[] }>): void;
};
let categoryBackend: CategoryBackend | null = null;

export function setCategoryBackend(backend: CategoryBackend) {
  categoryBackend = backend;
}

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
    const { customCategories: _names, categoryMembers: _members, ...stored } = state;
    localStorage.setItem(KEY, JSON.stringify(stored));
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
  if (raw.view === 'grid' || raw.view === 'compact' || raw.view === 'list') out.view = raw.view;
  if (typeof raw.sort === 'string') out.sort = raw.sort as AppState['sort'];
  if (raw.sortDir === 'asc' || raw.sortDir === 'desc') out.sortDir = raw.sortDir;
  const pending = readLocalCategories(raw.pendingCategoryImport) ?? readLocalCategories(raw);
  if (pending) out.pendingCategoryImport = pending;

  return out;
}

/** Categories as an older version stored them, or null if there are none worth keeping. */
function readLocalCategories(raw: unknown): LocalCategories | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { customCategories, categoryMembers } = raw as Record<string, unknown>;
  if (!Array.isArray(customCategories) || !customCategories.every((c) => typeof c === 'string')) {
    return undefined;
  }
  const members: Record<string, string[]> = {};
  if (
    typeof categoryMembers === 'object' &&
    categoryMembers !== null &&
    !Array.isArray(categoryMembers)
  ) {
    for (const [name, ids] of Object.entries(categoryMembers as Record<string, unknown>)) {
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
        members[name] = ids as string[];
      }
    }
  }
  const names = [...new Set([...(customCategories as string[]), ...Object.keys(members)])];
  return names.length > 0 ? { customCategories: names, categoryMembers: members } : undefined;
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
  hydrate();
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
    if (!trimmed || state.customCategories.includes(trimmed)) return;
    setState((s) => ({ customCategories: [...s.customCategories, trimmed] }));
    categoryBackend?.add(trimmed);
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
    categoryBackend?.remove(name);
  },
  renameCategory(name: string, nextName: string) {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === name || state.customCategories.includes(trimmed)) return;
    setState((s) => {
      const categoryMembers = { ...s.categoryMembers };
      categoryMembers[trimmed] = categoryMembers[name] ?? [];
      delete categoryMembers[name];
      return {
        customCategories: s.customCategories.map((c) => (c === name ? trimmed : c)),
        categoryMembers,
      };
    });
    categoryBackend?.rename(name, trimmed);
  },
  toggleCategoryMember(category: string, mangaId: string) {
    const list = state.categoryMembers[category] ?? [];
    const member = !list.includes(mangaId);
    setState((s) => ({
      categoryMembers: {
        ...s.categoryMembers,
        [category]: member ? [...list, mangaId] : list.filter((id) => id !== mangaId),
      },
    }));
    categoryBackend?.setMember(category, mangaId, member);
  },
  /** Adds titles to categories in bulk. An existing category of the same name (any case) is
   * reused, never duplicated. */
  mergeCategories(categories: Array<{ name: string; ids: string[] }>) {
    const merged = categories.map(({ name, ids }) => ({
      name:
        state.customCategories.find(
          (existing) => existing.trim().toLowerCase() === name.toLowerCase(),
        ) ?? name,
      ids,
    }));
    setState((s) => {
      const categoryMembers = { ...s.categoryMembers };
      const customCategories = [...s.customCategories];
      for (const { name, ids } of merged) {
        if (!customCategories.includes(name)) customCategories.push(name);
        categoryMembers[name] = [...new Set([...(categoryMembers[name] ?? []), ...ids])];
      }
      return { customCategories, categoryMembers };
    });
    categoryBackend?.merge(merged);
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

/** Shows what the server holds for the current identity. */
export function setServerCategories(categories: Array<{ name: string; manga_ids: string[] }>) {
  hydrate();
  setState({
    customCategories: categories.map(({ name }) => name),
    categoryMembers: Object.fromEntries(categories.map(({ name, manga_ids }) => [name, manga_ids])),
  });
}

export function getPendingCategoryImport(): LocalCategories | undefined {
  hydrate();
  return state.pendingCategoryImport;
}

export function clearPendingCategoryImport() {
  setState({ pendingCategoryImport: undefined });
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
