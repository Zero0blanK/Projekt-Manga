'use client';

import {
  EMPTY_IDS,
  parseIdList,
  parsePreference,
  profilePreferenceKey,
  useProfilePreference,
} from './profile-preferences';
import { actions, getAppState, getSetting, useSetting } from './app-store';
import { queryClient, queryKeys } from './query-client';
import type { PublicUser } from '@projekt-manga/api-client';

/**
 * App-wide incognito (the header's mask button, Settings › Privacy): while it is on,
 * reading leaves no history, saves no progress and pushes nothing to trackers, exactly as
 * a source in incognito does. Kept on this device only, like the browser's own private
 * mode, so turning it on here never silences another device.
 */
export const INCOGNITO_MODE = 'incognitoMode';

export function useAppIncognito(): boolean {
  return useSetting(INCOGNITO_MODE, false) === true;
}

export function isAppIncognito(): boolean {
  return getSetting(INCOGNITO_MODE, false) === true;
}

export function setAppIncognito(on: boolean) {
  actions.setSetting(INCOGNITO_MODE, on);
}

/** Whether reading this source is private: incognito for the source, or for the app. */
export function useSourceIncognito(sourceId: string) {
  const [sources] = useProfilePreference('incognitoSources', parseIdList, EMPTY_IDS);
  const app = useAppIncognito();
  return app || sources.includes(sourceId);
}

export function isSourceIncognito(sourceId: string) {
  if (isAppIncognito()) return true;
  const owner = queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous';
  return parsePreference(
    getAppState().settings[profilePreferenceKey('incognitoSources', owner)],
    parseIdList,
    EMPTY_IDS,
  ).includes(sourceId);
}
