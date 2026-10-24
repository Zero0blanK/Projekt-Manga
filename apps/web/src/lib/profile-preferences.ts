'use client';

import { useCallback, useMemo } from 'react';
import { actions, getAppState, useAppState } from './app-store';
import { useCurrentUser } from './session-resource';
import { queryClient, queryKeys } from './query-client';
import type { PublicUser } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';

export function profilePreferenceKey(name: string, owner: string): string {
  return `profile:${encodeURIComponent(owner)}:${name}`;
}

export function parsePreference<T>(raw: unknown, parse: (value: unknown) => T, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    const stored: unknown = JSON.parse(raw);
    if (
      !stored ||
      typeof stored !== 'object' ||
      !('version' in stored) ||
      stored.version !== 1 ||
      !('value' in stored)
    )
      return fallback;
    return parse(stored.value);
  } catch {
    return fallback;
  }
}

/** Preferences travel in the existing settings backup, but never across account profiles. */
export function useProfilePreference<T>(
  name: string,
  parse: (value: unknown) => T,
  fallback: T,
): [T, (next: T | ((current: T) => T)) => void] {
  const { user, loading } = useCurrentUser();
  const owner = user?.id ?? 'anonymous';
  const key = profilePreferenceKey(name, owner);
  const raw = useAppState((state) => state.settings[key]);
  const value = useMemo(
    () => (loading ? fallback : parsePreference(raw, parse, fallback)),
    [raw, parse, fallback, loading],
  );
  const setValue = useCallback(
    (next: T | ((current: T) => T)) => {
      if (loading) return;
      const currentOwner =
        queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous';
      if (currentOwner !== owner) return;
      const current = parsePreference(getAppState().settings[key], parse, fallback);
      const updated = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
      const persisted = actions.setSetting(
        key,
        JSON.stringify({ version: 1, value: parse(updated) }),
      );
      if (!persisted)
        toast({
          description:
            'This preference is saved for this session only. Device storage is unavailable or full; export your data before closing the app.',
        });
    },
    [key, loading, parse, fallback, owner],
  );
  return [value, setValue];
}

export function parseIdList(value: unknown, limit = 1000): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512,
      ),
    ),
  ].slice(0, limit);
}

export const EMPTY_IDS: string[] = [];

export function useReadingQueue() {
  return useProfilePreference('reading-queue', parseIdList, EMPTY_IDS);
}
