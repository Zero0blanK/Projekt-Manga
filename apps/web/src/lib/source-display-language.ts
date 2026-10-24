'use client';

import type { MangaFilter } from '@projekt-manga/types';
import { useProfilePreference } from './profile-preferences';

function parseLanguage(value: unknown): string {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value)
    ? value
    : 'all';
}

export function useSourceDisplayLanguage(sourceId: string | null) {
  return useProfilePreference(
    `sourceDisplayLanguage:${encodeURIComponent(sourceId ?? '')}`,
    parseLanguage,
    'all',
  );
}

export function sourceLanguageFilter(filters: MangaFilter[]) {
  return filters.find((filter) => filter.value === 'language' && filter.type === 'select');
}

export function sourceLanguageValues(
  filters: MangaFilter[],
  language: string,
): { language?: string } {
  const filter = sourceLanguageFilter(filters);
  return filter && language !== 'all' && filter.options?.some((option) => option.value === language)
    ? { language }
    : {};
}
