'use client';

import { useEffect, useState } from 'react';
import {
  Panel,
  Field,
  Group,
  Toggle,
  ActionButton,
  NumberSelect,
  Select,
} from '@/components/settings/field-controls';
import { useNumberSetting, useSetting } from '@/lib/app-store';
import { useMangaLibrary } from '@/lib/library-store';
import { showWindowNotification } from '@/lib/window-notification';
import { toast } from '@/hooks/use-toast';

type PermissionState = NotificationPermission | 'unsupported';
const TIME_OPTIONS = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? '00' : '30';
  return `${String(hour).padStart(2, '0')}:${minute}`;
});

/**
 * Desktop notifications go through the browser's Notification API, which requires an
 * explicit grant from a user gesture — so this asks for it here rather than silently at
 * first use, and reflects a denial instead of pretending the toggle worked.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
 */
function useNotificationPermission() {
  const [permission, setPermission] = useState<PermissionState>('default');

  useEffect(() => {
    setPermission(
      typeof window !== 'undefined' && 'Notification' in window
        ? Notification.permission
        : 'unsupported',
    );
  }, []);

  const request = async () => {
    if (permission === 'unsupported') return;
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      toast({
        variant: 'destructive',
        description: 'Could not request notification permission. Check your browser settings.',
      });
    }
  };

  return { permission, request };
}

export function NotificationsPanel() {
  const { permission, request } = useNotificationPermission();
  const desktopEnabled = useSetting('notifyDesktop', false) as boolean;
  const automaticUpdates = useSetting('automaticLibraryUpdates', true) as boolean;
  const intervalHours = useNumberSetting('automaticLibraryUpdateIntervalHours', 12);
  const quietHours = useSetting('quietHoursEnabled', false) as boolean;
  const { manga } = useMangaLibrary();
  const sources = [...new Set(manga.map((entry) => entry.source).filter(Boolean))].sort();
  const granted = permission === 'granted';

  const permissionLabel: Record<PermissionState, string> = {
    granted: 'Allowed',
    denied: 'Blocked in your browser',
    default: 'Not requested yet',
    unsupported: 'Not supported in this browser',
  };

  const test = () => {
    if (!granted) return;
    if (
      !showWindowNotification({
        title: 'Projekt Manga test',
        body: 'Notifications are ready. New chapter alerts will open your notification inbox.',
        tag: 'test',
        destination: '/notifications',
      })
    ) {
      toast({
        variant: 'destructive',
        title: 'Could not show a notification',
        description: 'Check your operating system notification settings.',
      });
    }
  };

  return (
    <div className="space-y-6">
      <Panel title="Notifications" subtitle="What the app tells you about">
        <Field
          label="New chapter alerts"
          hint="Shows the dot on the bell and lists chapters found by a library update"
        >
          <Toggle settingKey="notifyNewChapter" defaultOn />
        </Field>
        <Field label="Update errors" hint="Surface sources that failed during a library update">
          <Toggle settingKey="notifyUpdateErrors" defaultOn />
        </Field>
        <Field label="Download finished" hint="A toast when a chapter finishes downloading">
          <Toggle settingKey="notifyDownloadComplete" defaultOn />
        </Field>
      </Panel>

      <Panel title="Desktop notifications" subtitle="Alerts outside the app window">
        <Field label="Browser permission" hint={permissionLabel[permission]}>
          {permission === 'default' ? (
            <ActionButton onClick={request}>Allow notifications</ActionButton>
          ) : (
            <span className={`text-xs ${granted ? 'text-primary' : 'text-muted-foreground'}`}>
              {permissionLabel[permission]}
            </span>
          )}
        </Field>
        <Field
          label="Show desktop notifications"
          hint={
            granted
              ? 'Used for chapters found by a library update'
              : 'Needs browser permission first'
          }
          disabled={!granted}
        >
          <Toggle settingKey="notifyDesktop" />
        </Field>
        <Field
          label="Send a test"
          hint="Check it looks right"
          disabled={!granted || !desktopEnabled}
        >
          <ActionButton onClick={test}>Send test</ActionButton>
        </Field>
        <Group label="Quiet hours" />
        <Field
          label="Pause desktop alerts during quiet hours"
          hint="New chapters remain in your notification inbox"
        >
          <Toggle settingKey="quietHoursEnabled" />
        </Field>
        <Field label="Start" nested disabled={!quietHours}>
          <Select settingKey="quietHoursStart" options={TIME_OPTIONS} defaultValue="22:00" />
        </Field>
        <Field label="End" nested disabled={!quietHours}>
          <Select settingKey="quietHoursEnd" options={TIME_OPTIONS} defaultValue="07:00" />
        </Field>
      </Panel>

      <Panel
        title="Source alerts and cadence"
        subtitle="Choose source notifications and an optional minimum automatic check interval"
      >
        {sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add a title to your library to configure source alerts.
          </p>
        ) : (
          sources.map((source) => (
            <div key={source} className="space-y-2">
              <Field label={source} hint="Include this source in update alerts">
                <Toggle settingKey={`notifySource:${source}`} defaultOn />
              </Field>
              <Field
                label={`${source} automatic check minimum`}
                hint="The effective interval is the longer of this value and the global check interval. Manual checks are unaffected."
                nested
              >
                <NumberSelect
                  settingKey={`automaticLibraryUpdateSourceIntervalHours:${source}`}
                  options={[1, 6, 12, 24, 48, 72, 168]}
                  defaultValue={1}
                  format={(hours) => `${hours} hours`}
                />
              </Field>
            </div>
          ))
        )}
      </Panel>

      <Panel title="Scheduled checks" subtitle="Looking for new chapters on your behalf">
        <Group label="Automatic updates" />
        <Field
          label="Check for new chapters automatically"
          hint="Runs while Projekt Manga is open or minimized to the tray; quitting the app pauses checks. The default cadence is every 12 hours."
        >
          <Toggle settingKey="automaticLibraryUpdates" defaultOn />
        </Field>
        <Field
          label="Check interval"
          hint="A longer interval reduces requests to source websites"
          nested
          disabled={!automaticUpdates}
        >
          <NumberSelect
            settingKey="automaticLibraryUpdateIntervalHours"
            options={[6, 12, 24, 48, 72]}
            defaultValue={12}
            format={(hours) => `${hours} hours`}
          />
        </Field>
        <Field
          label="Current cadence"
          hint="Changing the interval applies after the next completed check"
          nested
          disabled={!automaticUpdates}
        >
          <span className="text-xs text-muted-foreground">Every {intervalHours} hours</span>
        </Field>
      </Panel>
    </div>
  );
}
