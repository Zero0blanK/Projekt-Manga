'use client';
import { desktopBridge } from '@/lib/desktop-bridge';
import { useEffect, useState } from 'react';
import type { SectionId } from './settings-nav';
type Match = { section: SectionId; label: string; description: string; desktop?: boolean };
const groups: Array<{ section: SectionId; description: string; labels: string[] }> = [
  {
    section: 'account',
    description: 'Profile, sign in and interface language',
    labels: ['Email', 'Display name', 'Other devices', 'Session', 'Interface language'],
  },
  {
    section: 'appearance',
    description: 'Interface style, theme, accent, covers, interface scale and accessibility',
    labels: [
      'Interface style',
      'Theme',
      'Glass effects',
      'Accent color',
      'Interface scale',
      'Interface density',
      'Library grid size',
      'Show chapter badge on covers',
      'Show unread count',
      'Opening animation',
      'Reduce motion',
      'Smooth scrolling',
    ],
  },
  {
    section: 'library',
    description: 'The library page, where new titles go, Update Library and scheduled checks',
    labels: [
      'Show Recently Updated',
      'Default shelf',
      'Skip finished titles',
      'Skip titles with unread chapters',
      'Skip titles not started',
      'Smart update',
      'Only these categories',
      'Never these categories',
      'Category check intervals',
      'Mute new-chapter alerts',
      'Check a title when you reload its page',
      'Refresh covers during update',
      'Check for new chapters automatically',
      'Check interval',
      'Source alerts and cadence',
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
      'Click zones',
      'Left zone',
      'Center zone',
      'Right zone',
      'Show missing chapters',
      'Mark duplicates read',
      'Automatically advance to next chapter',
      'Reader presets',
      'Reader background',
      'Brightness',
      'Colour filter',
      'Tint',
      'Tint strength',
      'Custom tint colour',
      'Tint blend',
      'Guided view',
      'Rotate wide pages',
      'Swap spread order',
      'Skip read chapters',
      'Skip filtered chapters',
      'Skip duplicate chapters',
      'Enhance low-resolution pages',
      'Translate pages into',
      'Translate pages automatically',
      'Page translation',
      'Translation API key',
      'Translate on this computer',
      'Crop borders',
      'Split wide pages',
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
    section: 'downloads',
    description: 'Where downloads are kept, disk storage and automatic downloads',
    labels: [
      'Open folder',
      'Storage limit',
      'Download new chapters',
      'Download ahead',
      'Delete after reading',
    ],
  },
  {
    section: 'extensions',
    description: 'Trusted source index URLs, repositories, installation and source health',
    labels: [
      'Add a repository',
      'Extension repositories',
      'Hide titles already in your library',
      'Open browser checks automatically',
      'Source health',
      'Suwayomi server',
    ],
  },
  {
    section: 'notifications',
    description: 'Chapter alerts, errors, desktop notifications, quiet hours and alert channels',
    labels: [
      'Outside the app',
      'Add a channel',
      'New chapter alerts',
      'Update errors',
      'Download finished',
      'Browser permission',
      'Show desktop notifications',
      'Send a test',
      'Pause desktop alerts during quiet hours',
    ],
  },
  {
    section: 'sync',
    description: 'Account synchronization across devices, and third-party trackers',
    labels: ['Cross-device sync', 'Trackers'],
  },
  {
    section: 'privacy',
    description:
      'Backup, restore, Mihon and Tachiyomi import, resets, adult visibility, covers and notification privacy',
    labels: [
      'Export your data',
      'Reset preferences',
      'Wipe selected data',
      'Import a backup',
      'Incognito mode',
      'Hide from screen capture',
      'App lock',
      'Import from Mihon/Tachiyomi…',
      'Delete account',
      'Hide adult sources',
      'Blur adult covers',
      'Private notification text',
    ],
  },
  {
    section: 'statistics',
    description: 'Library progress and recorded reading activity',
    labels: ['Reading goal', 'Year in manga', 'Statistics', 'Recent reading activity', 'Progress'],
  },
  {
    section: 'shortcuts',
    description: 'Keyboard shortcuts, key bindings and the reader mouse controls',
    labels: [
      'Mouse and keyboard',
      'Mouse wheel',
      'Double-click to zoom',
      'Keyboard shortcuts',
      'Navigation',
      'Search',
      'Reader',
    ],
  },
  {
    section: 'about',
    description: 'Versions, updates, start-up, diagnostics and application resources',
    labels: ['Server', 'Build', 'Diagnostics', 'Resources'],
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
    section: 'about',
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
  useEffect(() => setDesktop(desktopBridge() !== null), []);
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
