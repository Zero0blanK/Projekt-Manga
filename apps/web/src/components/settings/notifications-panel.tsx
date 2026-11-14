'use client';

import { useEffect, useState } from 'react';
import {
  Panel,
  Field,
  Group,
  Toggle,
  ActionButton,
  Select,
} from '@/components/settings/field-controls';
import { useSetting } from '@/lib/app-store';
import { showWindowNotification } from '@/lib/window-notification';
import { toast } from '@/hooks/use-toast';
import { AlertChannels } from '@/components/settings/alert-channels';

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
        description: "Couldn't request notification permission. Check your browser settings.",
      });
    }
  };

  return { permission, request };
}

export function NotificationsPanel() {
  const { permission, request } = useNotificationPermission();
  const desktopEnabled = useSetting('notifyDesktop', false) as boolean;
  const quietHours = useSetting('quietHoursEnabled', false) as boolean;
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
        title: "Couldn't show a notification",
        description: 'Check your operating system notification settings.',
      });
    }
  };

  return (
    <div className="space-y-6">
      <Panel title="Notifications" subtitle="What the app tells you about">
        <Field label="New chapter alerts" hint="Bell dot and list of new chapters">
          <Toggle settingKey="notifyNewChapter" defaultOn />
        </Field>
        <Field label="Update errors" hint="Sources that failed during an update">
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
        title="Outside the app"
        subtitle="New-chapter alerts to your phone or chat: ntfy, Discord, Telegram or a webhook"
      >
        <AlertChannels />
      </Panel>
    </div>
  );
}
