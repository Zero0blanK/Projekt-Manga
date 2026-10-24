'use client';

import type { PublicUser } from '@projekt-manga/api-client';
import { getAppState } from './app-store';
import { parsePreference, profilePreferenceKey } from './profile-preferences';
import { queryClient, queryKeys } from './query-client';

type AppNotification = {
  title: string;
  body: string;
  tag: 'library-update' | 'test';
  destination?: '/notifications';
};

/** One browser/Electron-renderer notification shape for both automatic and manual checks. */
export function showWindowNotification({
  title,
  body,
  tag,
  destination,
}: AppNotification): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (window.Notification.permission !== 'granted') return false;
  const user = queryClient.getQueryData<PublicUser | null>(queryKeys.session);
  const privateText = parsePreference(
    getAppState().settings[profilePreferenceKey('contentPrivacy', user?.id ?? 'anonymous')],
    (value) =>
      !!value &&
      typeof value === 'object' &&
      'privateNotifications' in value &&
      value.privateNotifications === true,
    false,
  );

  try {
    const notification = new window.Notification(privateText ? 'ProjektManga' : title, {
      body: privateText ? 'You have a notification. Open the app for details.' : body,
      icon: new URL('/brand/ProjektManga.logo.png', window.location.origin).href,
      tag: `projekt-manga:${tag}`,
      lang: document.documentElement.lang || 'en',
    });
    if (destination) {
      notification.onclick = () => {
        window.focus();
        notification.close();
        if (window.location.pathname !== destination) window.location.assign(destination);
      };
    }
    return true;
  } catch {
    // Permission may be granted even when the OS notification service is unavailable.
    return false;
  }
}
