'use client';

import {
  EMPTY_IDS,
  parseIdList,
  parsePreference,
  profilePreferenceKey,
  useProfilePreference,
} from './profile-preferences';
import { getAppState } from './app-store';
import { queryClient, queryKeys } from './query-client';
import type { PublicUser } from '@projekt-manga/api-client';

export function useSourceIncognito(sourceId: string) {
  const [sources] = useProfilePreference('incognitoSources', parseIdList, EMPTY_IDS);
  return sources.includes(sourceId);
}

export function isSourceIncognito(sourceId: string) {
  const owner = queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous';
  return parsePreference(
    getAppState().settings[profilePreferenceKey('incognitoSources', owner)],
    parseIdList,
    EMPTY_IDS,
  ).includes(sourceId);
}
