'use client';

import { useProfilePreference } from '@/lib/profile-preferences';
import { Field, ToggleSwitch } from '@/components/settings/field-controls';

export type ContentPrivacy = {
  hideAdult: boolean;
  blurAdult: boolean;
  privateNotifications: boolean;
};
const defaults: ContentPrivacy = {
  hideAdult: false,
  blurAdult: false,
  privateNotifications: false,
};
export function parseContentPrivacy(value: unknown): ContentPrivacy {
  if (!value || typeof value !== 'object') return defaults;
  const data = value as Partial<ContentPrivacy>;
  return {
    hideAdult: data.hideAdult === true,
    blurAdult: data.blurAdult === true,
    privateNotifications: data.privateNotifications === true,
  };
}
export function useContentPrivacy() {
  return useProfilePreference('contentPrivacy', parseContentPrivacy, defaults);
}
export function isAdultSource(rating: string | null | undefined, isNSFW: boolean) {
  return rating === 'nsfw' || (!rating && isNSFW);
}
export function ContentPrivacyControls() {
  const [preferences, setPreferences] = useContentPrivacy();
  return (
    <div>
      {(
        [
          [
            'hideAdult',
            'Hide adult sources',
            'Exclude adult-only sources from discovery and search. Mixed catalogues stay visible.',
          ],
          [
            'blurAdult',
            'Blur adult covers',
            'Blur covers identified as adult. Turn this setting off to show them.',
          ],
          [
            'privateNotifications',
            'Private notification text',
            'Use generic text instead of manga titles in notifications.',
          ],
        ] as const
      ).map(([key, label, hint]) => (
        <Field key={key} label={label} hint={hint}>
          <ToggleSwitch
            label={label}
            on={preferences[key]}
            onToggle={() => setPreferences((current) => ({ ...current, [key]: !current[key] }))}
          />
        </Field>
      ))}
    </div>
  );
}
