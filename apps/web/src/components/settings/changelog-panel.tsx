'use client';

import { useState } from 'react';
import { Panel } from '@/components/settings/field-controls';
import { ChangelogChanges } from '@/components/changelog-changes';
import { RELEASES } from '@/lib/changelog';

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
            <div className="mt-3">
              <ChangelogChanges changes={release.changes} />
            </div>
          </div>
        ))}
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full rounded-lg border border-border/60 py-2 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          Show {hiddenCount} older release{hiddenCount === 1 ? '' : 's'}
        </button>
      )}
    </Panel>
  );
}
