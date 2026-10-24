'use client';

import type { Mangas } from '@projekt-manga/types';
import { parseIdList, useProfilePreference } from './profile-preferences';

export type MigrationOptions = {
  read: boolean;
  shelf: boolean;
  bookmark: boolean;
  categories: boolean;
};
export type MigrationPreferences = {
  options: MigrationOptions;
  sourceOrder: string[];
  hideUnmatched: boolean;
};
export type MigrationSearchStatus = {
  state: 'idle' | 'searching' | 'complete' | 'paused';
  sourceIds: string[];
  settled: string[];
  failed: string[];
};
export const DEFAULT_MIGRATION_PREFERENCES: MigrationPreferences = {
  options: { read: true, shelf: true, bookmark: true, categories: true },
  sourceOrder: [],
  hideUnmatched: false,
};
export function parseMigrationPreferences(value: unknown): MigrationPreferences {
  if (!value || typeof value !== 'object') return DEFAULT_MIGRATION_PREFERENCES;
  const input = value as Partial<MigrationPreferences>;
  const options = Object.fromEntries(
    Object.entries(DEFAULT_MIGRATION_PREFERENCES.options).map(([key, fallback]) => {
      const candidate = input.options?.[key as keyof MigrationOptions];
      return [key, typeof candidate === 'boolean' ? candidate : fallback];
    }),
  ) as MigrationOptions;
  return {
    options,
    sourceOrder: parseIdList(input.sourceOrder),
    hideUnmatched: input.hideUnmatched === true,
  };
}
export function useMigrationPreferences() {
  return useProfilePreference(
    'migration',
    parseMigrationPreferences,
    DEFAULT_MIGRATION_PREFERENCES,
  );
}

export type MigrationSearchSnapshot = {
  query: string;
  appliedQuery: string;
  options: MigrationOptions;
  hideUnmatched: boolean;
  hideAdult: boolean;
  results: Mangas[];
  status: MigrationSearchStatus;
  scrollY: number;
  rails: Record<string, number>;
};
// Only search sessions are retained. Transfers and cleanup are never resumed implicitly.
const sessions = new Map<string, MigrationSearchSnapshot>();
const keyFor = (owner: string, mangaId: string) =>
  `projekt-manga:migration-search:${JSON.stringify([owner, mangaId])}`;
function isSearchSnapshot(value: unknown): value is MigrationSearchSnapshot {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<MigrationSearchSnapshot>;
  const ids = (value: unknown) =>
    Array.isArray(value) && value.length <= 1000 && value.every((id) => typeof id === 'string');
  const offset = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return (
    typeof data.query === 'string' &&
    typeof data.appliedQuery === 'string' &&
    typeof data.hideAdult === 'boolean' &&
    typeof data.hideUnmatched === 'boolean' &&
    !!data.options &&
    Object.keys(DEFAULT_MIGRATION_PREFERENCES.options).every(
      (key) => typeof data.options?.[key as keyof MigrationOptions] === 'boolean',
    ) &&
    !!data.status &&
    ['idle', 'searching', 'complete', 'paused'].includes(data.status.state) &&
    ids(data.status.sourceIds) &&
    ids(data.status.settled) &&
    ids(data.status.failed) &&
    Array.isArray(data.results) &&
    data.results.length <= 20_000 &&
    data.results.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.source === 'string' &&
        (item.thumbnail_url == null || typeof item.thumbnail_url === 'string'),
    ) &&
    offset(data.scrollY) &&
    !!data.rails &&
    typeof data.rails === 'object' &&
    !Array.isArray(data.rails) &&
    Object.values(data.rails).every(offset)
  );
}
export function saveMigrationSearch(
  owner: string,
  mangaId: string,
  value: MigrationSearchSnapshot,
) {
  const key = keyFor(owner, mangaId);
  sessions.delete(key);
  sessions.set(key, value);
  while (sessions.size > 20) sessions.delete(sessions.keys().next().value!);
  try {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, value }));
  } catch {
    /* Navigation can still restore the in-memory snapshot if storage is unavailable. */
  }
}
export function takeMigrationSearch(owner: string, mangaId: string, hideAdult: boolean) {
  const key = keyFor(owner, mangaId);
  let session = sessions.get(key);
  sessions.delete(key);
  try {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    const stored: unknown = JSON.parse(raw ?? 'null');
    if (
      !session &&
      stored &&
      typeof stored === 'object' &&
      'version' in stored &&
      stored.version === 1 &&
      'value' in stored &&
      isSearchSnapshot(stored.value)
    )
      session = stored.value;
  } catch {
    /* A corrupt or unavailable storage entry never blocks migration. */
  }
  if (!session || session.hideAdult !== hideAdult) return null;
  return session;
}

export function migrationReadTargets(
  original: Array<{ chapter_number: number; is_read?: boolean }>,
  replacement: Array<{ id: string; chapter_number: number }>,
) {
  const completed = new Set(
    original.filter((chapter) => chapter.is_read).map((chapter) => chapter.chapter_number),
  );
  return new Set(
    replacement
      .filter((chapter) => completed.has(chapter.chapter_number))
      .map((chapter) => chapter.id),
  );
}
