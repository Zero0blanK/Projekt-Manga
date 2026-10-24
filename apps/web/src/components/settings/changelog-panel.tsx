'use client';

import { useState } from 'react';
import { Panel } from '@/components/settings/field-controls';
import { RELEASES, CHANGE_LABELS, type ChangeType } from '@/lib/changelog';

const TYPE_STYLES: Record<ChangeType, string> = {
  added: 'border-primary/40 bg-primary/10 text-primary',
  changed: 'border-border/70 bg-muted/60 text-foreground',
  fixed: 'border-border/70 bg-muted/40 text-muted-foreground',
  removed: 'border-destructive/40 bg-destructive/10 text-destructive',
};

/** Releases shown before the "older releases" button. */
const VISIBLE_RELEASES = 3;

export function ChangelogPanel() {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? RELEASES : RELEASES.slice(0, VISIBLE_RELEASES);
  const hiddenCount = RELEASES.length - visible.length;

  return (
    <Panel
      title="Changelog"
      subtitle={`What's new in Projekt Manga — ${RELEASES.length} release${RELEASES.length === 1 ? '' : 's'}`}
    >
      <div className="divide-y divide-border/50">
        {visible.map((release, i) => (
          <div key={release.version} className="py-4 first:pt-0">
            <div className="flex items-baseline gap-3">
              <span className="text-sm font-semibold text-foreground">v{release.version}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(release.date).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
              {i === 0 && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  Current
                </span>
              )}
            </div>
            <ul className="mt-3 space-y-2">
              {release.changes.map((change) => (
                <li key={change.text} className="flex items-start gap-2.5">
                  <span
                    className={`mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TYPE_STYLES[change.type]}`}
                  >
                    {CHANGE_LABELS[change.type]}
                  </span>
                  <span className="text-sm text-muted-foreground">{change.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {hiddenCount > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full rounded-lg border border-border/60 py-2 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          Show {hiddenCount} older release{hiddenCount === 1 ? '' : 's'}
        </button>
      )}
    </Panel>
  );
}
