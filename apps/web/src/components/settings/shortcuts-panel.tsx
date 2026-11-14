'use client';

import { useEffect, useState } from 'react';
import { Field, Group, Panel, Select, Toggle } from '@/components/settings/field-controls';
import { KeyBindingsEditor } from '@/components/settings/key-bindings-editor';
import { useSetting } from '@/lib/app-store';
import {
  READER_ACTIONS,
  READER_DOUBLE_CLICK_ZOOM,
  READER_KEY_BINDINGS,
  READER_WHEEL_ACTION,
  WHEEL_ACTIONS,
  keyLabel,
  parseKeyBindings,
} from '@/lib/reader-keys';

/**
 * Every shortcut the app actually binds. Grouped by where it works, since a reader-only
 * key looks broken if you try it on the library.
 *
 * Sources of truth: `components/app-shell.tsx` (G-prefixed navigation),
 * `components/floating-nav.tsx` (search), `components/command-palette.tsx`, the desktop
 * app menu (`apps/desktop/src/main/app-menu.ts`) and, for the reader, the bindings in
 * `lib/reader-keys.ts`, which this panel reads so a rebound key shows here too.
 */
const GROUPS: Array<{ title: string; note?: string; rows: Array<[string, string[]]> }> = [
  {
    title: 'Navigation',
    note: 'Press G, then the letter',
    rows: [
      ['Library', ['G', 'L']],
      ['Discover', ['G', 'D']],
      ['Recents', ['G', 'H']],
      ['Downloads', ['G', 'W']],
      ['Bookmarks', ['G', 'B']],
      ['Settings', ['G', 'S']],
    ],
  },
  {
    title: 'Search',
    rows: [
      ['Focus the search box', ['Mod', 'K']],
      ['Command palette', ['Mod', 'Shift', 'P']],
      ['Close search or a panel', ['Esc']],
    ],
  },
  {
    title: 'Desktop app',
    note: 'In the desktop app only; Ctrl+click or middle-click a link opens it in a new window',
    rows: [
      ['Library', ['Mod', '1']],
      ['Discover', ['Mod', '2']],
      ['History', ['Mod', '3']],
      ['Downloads', ['Mod', '4']],
      ['Upcoming releases', ['Mod', '5']],
      ['Settings', ['Mod', ',']],
      ['Fullscreen', ['F11']],
      ['Show the menu bar', ['Alt']],
    ],
  },
];

/** The reader's keys as they are bound now: change them in Settings › Reader. */
function useReaderGroup() {
  const bindings = parseKeyBindings(useSetting(READER_KEY_BINDINGS, ''));
  return {
    title: 'Reader',
    note: 'Change these under Mouse and keyboard, above',
    rows: READER_ACTIONS.flatMap(({ id, label }) =>
      bindings[id].map((key): [string, string[]] => [label, [keyLabel(key)]]),
    ),
  };
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-xs text-muted-foreground">then</span>}
          <kbd className="rounded-md border border-border/80 bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function ShortcutsPanel() {
  // ⌘ on Apple platforms, Ctrl everywhere else. Resolved after mount so the server and
  // first client render agree.
  const [modifier, setModifier] = useState('Ctrl');
  const readerGroup = useReaderGroup();
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setModifier('⌘');
  }, []);

  return (
    <div className="space-y-6">
      {/* The reader's mouse and keyboard controls, with the key bindings to change. */}
      <Panel title="Mouse and keyboard" subtitle="Desktop reading controls">
        <Field label="Mouse wheel" hint="In the paged reader; Ctrl+wheel always zooms">
          <Select
            settingKey={READER_WHEEL_ACTION}
            options={[...WHEEL_ACTIONS]}
            defaultValue="Turn page"
          />
        </Field>
        <Field
          label="Double-click to zoom"
          hint="Zoom in where you click; single clicks wait a moment to tell them apart"
        >
          <Toggle settingKey={READER_DOUBLE_CLICK_ZOOM} defaultOn />
        </Field>
        <Group label="Keyboard" />
        <KeyBindingsEditor />
      </Panel>

      {[...GROUPS, readerGroup].map((group) => (
        <Panel key={group.title} title={group.title} subtitle={group.note ?? 'Fly through the app'}>
          <div className="divide-y divide-border/50">
            {group.rows.map(([label, keys], i) => (
              <div
                key={`${label}-${i}`}
                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <span className="text-sm text-foreground">{label}</span>
                <Keys keys={keys.map((k) => (k === 'Mod' ? modifier : k))} />
              </div>
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}
