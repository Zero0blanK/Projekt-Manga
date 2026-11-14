'use client';

import {
  Field,
  Group,
  NumberSelect,
  OptionSelect,
  Panel,
  Toggle,
} from '@/components/settings/field-controls';
import { SourceAlerts } from '@/components/settings/source-alerts';
import { SyncPanel } from '@/components/settings/sync-panel';
import { SHELF_OPTIONS, useNumberSetting, useSetting } from '@/lib/app-store';
import { SHOW_RECENTLY_UPDATED } from '@/lib/library-layout';

const SHELF_CHOICES = [{ value: 'none', label: 'None' }, ...SHELF_OPTIONS];

/**
 * Settings › Library: the library page, where new titles go, and keeping it up to date
 * (what Update Library checks, scheduled checks, and per-source alerts).
 */
export function LibraryPanel() {
  const automaticUpdates = useSetting('automaticLibraryUpdates', true) as boolean;
  const intervalHours = useNumberSetting('automaticLibraryUpdateIntervalHours', 12);

  return (
    <div className="space-y-6">
      <Panel title="Library" subtitle="The library page, and where new titles go">
        <Field
          label="Show Recently Updated"
          hint="The column of the latest chapters beside your library, on wide screens"
        >
          <Toggle settingKey={SHOW_RECENTLY_UPDATED} />
        </Field>
        <Field label="Default shelf" hint="Where titles added from Discover go">
          <OptionSelect settingKey="defaultShelf" options={SHELF_CHOICES} defaultValue="none" />
        </Field>
      </Panel>

      <SyncPanel show="library" />

      <Panel title="Scheduled checks" subtitle="Looking for new chapters on your behalf">
        <Group label="Automatic updates" />
        <Field
          label="Check for new chapters automatically"
          hint="Runs while the app is open or in the tray"
        >
          <Toggle settingKey="automaticLibraryUpdates" defaultOn />
        </Field>
        <Field
          label="Check interval"
          hint="Longer intervals send fewer requests to sources"
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
          hint="Takes effect after the next check"
          nested
          disabled={!automaticUpdates}
        >
          <span className="text-xs text-muted-foreground">Every {intervalHours} hours</span>
        </Field>
        <SourceAlerts />
      </Panel>
    </div>
  );
}
