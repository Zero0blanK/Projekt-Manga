'use client';

import { useMemo, useRef, useState } from 'react';
import { BellRing } from 'lucide-react';
import { Field, NumberSelect, Toggle } from '@/components/settings/field-controls';
import { useAppState } from '@/lib/app-store';
import { useMangaLibrary, useSources } from '@/lib/library-store';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const NOTIFY = (source: string) => `notifySource:${source}`;
const MINIMUM = (source: string) => `automaticLibraryUpdateSourceIntervalHours:${source}`;

/**
 * Per-source alerts and a minimum time between automatic checks, for the sources of the
 * titles in the library. A summary row here, the list in a dialog: one pair of controls per
 * source would otherwise grow this page without end.
 */
export function SourceAlerts() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { manga } = useMangaLibrary();
  const sourceIds = useMemo(
    () => [...new Set(manga.map((entry) => entry.source).filter(Boolean))].sort(),
    [manga],
  );
  const settings = useAppState((state) => state.settings);
  const muted = sourceIds.filter((id) => settings[NOTIFY(id)] === false).length;
  const slowed = sourceIds.filter((id) => Number(settings[MINIMUM(id)] ?? 1) > 1).length;

  const summary =
    sourceIds.length === 0
      ? 'Add a title to your library to set these per source'
      : [
          `${sourceIds.length - muted} of ${sourceIds.length} source${sourceIds.length === 1 ? '' : 's'} alert`,
          slowed > 0 ? `${slowed} checked less often` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <Field label="Source alerts and cadence" hint={summary}>
      <button
        ref={trigger}
        type="button"
        disabled={sourceIds.length === 0}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface/60 disabled:opacity-50"
      >
        <BellRing className="h-3.5 w-3.5 text-muted-foreground" />
        Choose per source
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Source alerts and cadence</DialogTitle>
            <DialogDescription>
              Which sources count towards new-chapter alerts, and how long to wait between automatic
              checks of each. A source uses the longer of its own minimum and the library-wide
              interval.
            </DialogDescription>
          </DialogHeader>
          {/* Mounted only while open: nothing renders per source for a closed dialog. */}
          {open && <SourceAlertList sourceIds={sourceIds} />}
          <DialogFooter>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Field>
  );
}

function SourceAlertList({ sourceIds }: { sourceIds: string[] }) {
  const { sources } = useSources();
  const [query, setQuery] = useState('');
  const named = sourceIds
    .map((id) => ({ id, name: sources.find((source) => source.id === id)?.name ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? named.filter(({ id, name }) => `${name} ${id}`.toLowerCase().includes(needle))
    : named;

  return (
    <div className="space-y-3">
      {named.length > 6 && (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a source"
          aria-label="Find a source"
          className="w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary/60"
        />
      )}
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">No source matches “{query}”.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {shown.map(({ id, name }) => (
            <li key={id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <Field label={name} hint="Include this source in new-chapter alerts">
                <Toggle settingKey={NOTIFY(id)} defaultOn />
              </Field>
              <Field label={`${name} automatic check minimum`} hint="Time between checks" nested>
                <NumberSelect
                  settingKey={MINIMUM(id)}
                  options={[1, 6, 12, 24, 48, 72, 168]}
                  defaultValue={1}
                  format={(hours) => `${hours} hours`}
                />
              </Field>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
