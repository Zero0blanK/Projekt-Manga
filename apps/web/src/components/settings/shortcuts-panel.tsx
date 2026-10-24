'use client';

import { useEffect, useState } from 'react';
import { Panel } from '@/components/settings/field-controls';

/**
 * Every shortcut the app actually binds. Grouped by where it works, since a reader-only
 * key looks broken if you try it on the library.
 *
 * Sources of truth: `components/app-shell.tsx` (G-prefixed navigation),
 * `components/floating-nav.tsx` (search), `app/reader/[id]/client.tsx` (zoom, immersive),
 * and `components/reader/paged-viewer.tsx` (paging).
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
      ['Close search or a panel', ['Esc']],
    ],
  },
  {
    title: 'Reader',
    note: 'Paging applies to single and two-page layouts; the long strip scrolls normally',
    rows: [
      ['Next page', ['→']],
      ['Next page', ['Space']],
      ['Previous page', ['←']],
      ['Toggle immersive mode', ['F']],
      ['Zoom in', ['+']],
      ['Zoom out', ['−']],
      ['Reset zoom', ['0']],
    ],
  },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-muted-foreground">then</span>}
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
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setModifier('⌘');
  }, []);

  return (
    <div className="space-y-6">
      {GROUPS.map((group) => (
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
