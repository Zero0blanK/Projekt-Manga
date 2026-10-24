'use client';
import { useEffect, useState } from 'react';
import type { SectionId } from './settings-nav';
type Match = { section: SectionId; label: string; description: string; desktop?: boolean };
const groups: Array<{ section: SectionId; description: string; labels: string[] }> = [
  {
    section: 'account',
    description: 'Profile, sign in, library defaults and third-party trackers',
    labels: [
      'Email',
      'Display name',
      'Other devices',
      'Session',
      'Interface language',
      'Default shelf',
      'Show unread count',
      'Trackers',
    ],
  },
  {
    section: 'appearance',
    description: 'Theme, accent, covers, interface scale and accessibility',
    labels: [
      'Theme',
      'Accent color',
      'Interface scale',
      'Interface density',
      'Library grid size',
      'Show chapter badge on covers',
      'Reduce motion',
      'Smooth scrolling',
    ],
  },
  {
    section: 'reader',
    description: 'Chapter display, navigation, fit, reading direction and image preloading',
    labels: [
      'Reading direction',
      'Per-source direction',
      'Page layout',
      'Zoom behavior',
      'Offset first page',
      'Page gap',
      'Scroll speed',
      'Auto-scroll',
      'Auto-scroll speed',
      'Left third',
      'Center third',
      'Right third',
      'Automatically advance to next chapter',
      'Reader presets',
      'Reader background',
      'Brightness',
      'Show page number',
      'Immersive mode',
      'Hide controls when scrolling down',
      'Keep screen awake',
      'Pages to preload ahead',
      'Preload next chapter',
      'Chapters to preload',
    ],
  },
  {
    section: 'extensions',
    description: 'Trusted source index URLs, repositories and installation',
    labels: ['Add a repository', 'Extension repositories'],
  },
  {
    section: 'notifications',
    description: 'Chapter alerts, errors, desktop notifications, quiet hours and scheduling',
    labels: [
      'New chapter alerts',
      'Update errors',
      'Download finished',
      'Browser permission',
      'Show desktop notifications',
      'Send a test',
      'Pause desktop alerts during quiet hours',
      'Source alerts and cadence',
      'Check for new chapters automatically',
      'Check interval',
    ],
  },
  {
    section: 'sync',
    description: 'Downloads, disk storage, library updates and account synchronization',
    labels: [
      'Open folder',
      'Storage limit',
      'Skip finished titles',
      'Check a title when you reload its page',
      'Refresh covers during update',
      'Cross-device sync',
      'Auto-download new chapters',
    ],
  },
  {
    section: 'privacy',
    description: 'Backup, restore, resets, adult visibility, covers and notification privacy',
    labels: [
      'Export your data',
      'Reset preferences',
      'Wipe selected data',
      'Import a backup',
      'Delete account',
      'Hide adult sources',
      'Blur adult covers',
      'Private notification text',
    ],
  },
  {
    section: 'statistics',
    description: 'Library progress and recorded reading activity',
    labels: ['Statistics', 'Recent reading activity', 'Progress'],
  },
  {
    section: 'shortcuts',
    description: 'Keyboard shortcuts for navigation, search and the reader',
    labels: ['Navigation', 'Search', 'Reader'],
  },
  {
    section: 'about',
    description: 'Versions, health, diagnostics and application resources',
    labels: ['Server', 'Build', 'Diagnostics', 'Source health', 'Resources'],
  },
  { section: 'changelog', description: 'Release history and changes', labels: ['Changelog'] },
];
const matches: Match[] = [
  ...groups.flatMap((group) =>
    group.labels.map((label) => ({
      section: group.section,
      label,
      description: group.description,
    })),
  ),
  {
    section: 'sync',
    label: 'Sync this device',
    description: 'Pause account synchronization on this desktop',
    desktop: true,
  },
  {
    section: 'sync',
    label: 'Automatic sync',
    description: 'Desktop sync interval while active and online',
    desktop: true,
  },
  {
    section: 'sync',
    label: 'Run in background at sign-in',
    description: 'Start the desktop app in the system tray',
    desktop: true,
  },
];
export function SettingsSearch({
  onSelect,
  query = '',
}: {
  onSelect: (section: SectionId, label: string) => void;
  query?: string;
}) {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(Boolean((window as unknown as { desktop?: unknown }).desktop)), []);
  const normalized = query.trim().toLocaleLowerCase();
  const results = normalized
    ? matches.filter((match) =>
        `${match.label} ${match.description}`.toLocaleLowerCase().includes(normalized),
      )
    : [];
  return (
    <div>
      {normalized && (
        <div className="mt-2 rounded-xl border border-border p-3">
          <p role="status" className="text-xs text-muted-foreground">
            {results.length} matching settings
          </p>
          <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
            {results.map((match) => (
              <li key={`${match.section}:${match.label}`}>
                <button
                  data-setting-result
                  type="button"
                  disabled={match.desktop && !desktop}
                  onClick={() => {
                    onSelect(match.section, match.label);
                  }}
                  className="w-full rounded-lg px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-60"
                >
                  <span className="font-medium">{match.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{match.section}</span>
                  <span className="block text-xs text-muted-foreground">
                    {match.desktop && !desktop
                      ? 'Available in the desktop app. This browser cannot change this setting.'
                      : match.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
