'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowRightLeft, Check, Eye, Loader2, Search, Undo2 } from 'lucide-react';
import type { Manga } from '@/lib/manga-data';
import { useLibraryState, useMangaLibrary, useSources } from '@/lib/library-store';
import { useInstalledExtensions } from '@/lib/extensions-store';
import { installedExtensionFor } from '@projekt-manga/types';
import { isAdultSource, useContentPrivacy } from '@/components/discover/content-privacy';
import { useCurrentUser } from '@/lib/session-resource';
import { useMigrationPreferences, type MigrationOptions } from '@/lib/migration-state';
import { sourceLanguageName } from '@/lib/source-language';
import {
  bulkMigration,
  bulkProgress,
  isIncluded,
  useBulkMigration,
  type BulkRow,
} from '@/lib/bulk-migration';
import { Cover } from '@/components/cover';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { SourceOrderList } from '@/components/settings/source-order-list';
import { MatchDialog } from './match-dialog';

const optionLabels: Record<keyof MigrationOptions, string> = {
  read: 'Completed progress',
  shelf: 'Reading shelf',
  bookmark: 'Bookmark',
  categories: 'Categories',
};

/** Titles a Mihon import kept without a source are stored under `mihon:<name>`. */
const sourceLabel = (id: string, name?: string) =>
  name ?? (id.startsWith('mihon:') ? `${id.slice(6)} (from a Mihon backup)` : id);

/**
 * Library › Migrate a source: moves every library title from one source to others in one
 * go. Each title is searched by name in the chosen sources, in order; the reader reviews,
 * previews or replaces the matches, then the titles migrate one at a time. The work lives
 * in `lib/bulk-migration`, so it carries on, and is still here, after leaving the page.
 */
export function BulkMigration({ initialSource }: { initialSource?: string }) {
  const { sources } = useSources();
  const { manga: library, refresh } = useMangaLibrary();
  const { shelf, bookmarks } = useLibraryState();
  const { installed } = useInstalledExtensions();
  const [privacy] = useContentPrivacy();
  const { loading: sessionLoading } = useCurrentUser();
  const [preferences] = useMigrationPreferences();
  const work = useBulkMigration();
  const [dialog, setDialog] = useState<{ row: BulkRow; search: boolean } | null>(null);
  const options = work.options ?? preferences.options;

  const inLibrary = useMemo(() => library.filter((entry) => entry.inLibrary), [library]);
  // Every source with library titles, including ones no longer installed.
  const fromSources = useMemo(() => {
    const bySource = new Map<string, Manga[]>();
    for (const entry of inLibrary)
      bySource.set(entry.source, [...(bySource.get(entry.source) ?? []), entry]);
    return [...bySource.entries()]
      .map(([id, titles]) => {
        const source = sources.find((candidate) => candidate.id === id);
        return {
          id,
          titles,
          name: sourceLabel(id, source?.name),
          lang: source?.lang ?? null,
          installed: !!source,
        };
      })
      .sort((a, b) => b.titles.length - a.titles.length || a.name.localeCompare(b.name));
  }, [inLibrary, sources]);
  const fromSource = fromSources.find((source) => source.id === work.from);
  const targets = sources.filter(
    (entry) =>
      entry.id !== work.from &&
      (!privacy.hideAdult ||
        !isAdultSource(installedExtensionFor(installed, entry.id)?.content_rating, entry.isNSFW)),
  );
  // Starts from the order single migrations use, until the reader changes it.
  const targetOrder = (work.order ?? preferences.sourceOrder).filter((id) =>
    targets.some((source) => source.id === id),
  );
  const nameOf = (id: string) => sources.find((source) => source.id === id)?.name ?? id;
  const progress = bulkProgress(work);
  const included = work.rows.filter(isIncluded).length;
  const remaining = work.rows.filter((row) => isIncluded(row) && row.run.state !== 'done').length;
  const migrated = work.rows.filter((row) => row.run.state === 'done').length;
  const missing = work.rows.filter((row) => !row.match && row.search === 'missing' && !row.skipped);
  const running = work.stage === 'running';
  const migrate = () =>
    void bulkMigration.migrate(options, {
      library,
      shelf,
      bookmarks,
      refresh: () => void refresh(),
    });

  if (work.stage === 'choose')
    return (
      <section aria-labelledby="bulk-from" className="space-y-3">
        <div>
          <h2 id="bulk-from" className="text-lg font-semibold tracking-tight">
            Move titles from
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick the source whose library titles you want to move.
          </p>
        </div>
        {fromSources.length ? (
          <ul className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
            {fromSources.map((source) => (
              <li
                key={source.id}
                className={`flex items-center gap-3 px-4 py-3 ${
                  source.id === initialSource ? 'bg-primary/5' : ''
                }`}
              >
                <div className="flex shrink-0 -space-x-3">
                  {source.titles.slice(0, 3).map((title) => (
                    <Cover
                      key={title.id}
                      sourceId={title.source}
                      src={title.thumbnailUrl}
                      alt=""
                      className="aspect-[2/3] w-8 shrink-0 ring-2 ring-background"
                    />
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{source.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {source.titles.length} title{source.titles.length === 1 ? '' : 's'}
                    {source.lang && ` · ${sourceLanguageName(source.lang)}`}
                    {!source.installed && ' · not installed'}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Migrate titles from ${source.name}`}
                  onClick={() => bulkMigration.chooseSource(source.id)}
                >
                  <ArrowRightLeft size={14} className="mr-1.5" aria-hidden="true" />
                  Migrate
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Your library is empty.</p>
        )}
      </section>
    );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-surface/40 px-4 py-3">
      <p className="min-w-0 text-sm">
        <span className="text-muted-foreground">Moving from </span>
        <span className="font-medium">{fromSource?.name ?? sourceLabel(work.from)}</span>
        {targetOrder.length > 0 && work.stage !== 'targets' && (
          <span className="text-muted-foreground">
            {' '}
            to {targetOrder.map(nameOf).join(', then ')}
          </span>
        )}
      </p>
      {!running && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            work.stage === 'targets' ? bulkMigration.backToSources() : bulkMigration.backToTargets()
          }
        >
          {work.stage === 'targets' ? 'Change source' : 'Change sources'}
        </Button>
      )}
    </div>
  );

  if (work.stage === 'targets')
    return (
      <form
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (targetOrder.length && fromSource)
            void bulkMigration.findMatches(fromSource.titles, targetOrder);
        }}
      >
        {header}
        <section className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight">Look for them in</h2>
          <p className="text-sm text-muted-foreground">
            Each title is searched by name in these sources, top first, and the first close match is
            used. Add sources from the list; hold a row and drag it to reorder.
          </p>
          <div className="sm:max-w-md">
            <SourceOrderList
              sources={targets}
              value={targetOrder}
              onChange={bulkMigration.setOrder}
              label="Sources to search, in order"
            />
          </div>
        </section>
        <fieldset className="space-y-2">
          <legend className="text-lg font-semibold tracking-tight">Carry over</legend>
          <p className="text-sm text-muted-foreground">
            Your history and reading progress on the originals are always kept.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
            {(Object.keys(optionLabels) as Array<keyof MigrationOptions>).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={options[key]}
                  onChange={() => bulkMigration.setOptions({ ...options, [key]: !options[key] })}
                />
                {optionLabels[key]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border/60 bg-background/95 py-4 backdrop-blur">
          <p className="text-sm text-muted-foreground">
            {!targetOrder.length
              ? 'Add at least one source to search.'
              : `${fromSource?.titles.length ?? 0} titles will be searched.`}
          </p>
          <Button type="submit" disabled={!targetOrder.length || !fromSource || sessionLoading}>
            Find matches
          </Button>
        </div>
      </form>
    );

  return (
    <div className="space-y-4">
      {header}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-sm text-muted-foreground">
            {work.stage === 'matches'
              ? progress.active
                ? `Searching… ${progress.done} of ${progress.total} titles`
                : `${work.rows.filter((row) => row.match).length} of ${work.rows.length} titles have a match.${
                    missing.length ? ` Choose ${missing.length} by hand or skip them.` : ''
                  }`
              : running
                ? `Migrating… ${progress.done} of ${progress.total}`
                : `${migrated} migrated${remaining ? `, ${remaining} not yet` : ''}.`}
          </p>
          <div className="flex gap-2">
            {running && (
              <Button type="button" variant="outline" onClick={bulkMigration.stop}>
                Stop after this title
              </Button>
            )}
            {work.stage === 'finished' && remaining > 0 && (
              <Button type="button" variant="outline" onClick={migrate}>
                Retry the remaining {remaining}
              </Button>
            )}
            {work.stage === 'matches' && (
              <Button
                type="button"
                disabled={progress.active || !included || sessionLoading}
                onClick={migrate}
              >
                Migrate {included} title{included === 1 ? '' : 's'}
              </Button>
            )}
            {work.stage === 'finished' && (
              <Button type="button" variant="ghost" onClick={bulkMigration.reset}>
                Migrate another source
              </Button>
            )}
          </div>
        </div>
        {progress.active && (
          <Progress
            value={progress.total ? (progress.done / progress.total) * 100 : 0}
            aria-hidden="true"
          />
        )}
      </div>
      <ul className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
        {work.rows.map((row) => {
          const settled = row.search === 'found' || row.search === 'missing';
          return (
            <li
              key={row.manga.id}
              className={`flex items-center gap-3 px-3 py-2.5 sm:px-4 ${row.skipped ? 'opacity-60' : ''}`}
            >
              <Cover
                sourceId={row.manga.source}
                src={row.manga.thumbnailUrl}
                alt=""
                className="aspect-[2/3] w-9 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <Link
                  href={`/manga/${encodeURIComponent(row.manga.id)}`}
                  className="block truncate text-sm font-medium hover:text-primary"
                >
                  {row.manga.title}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {row.skipped ? (
                    'Skipped'
                  ) : !settled ? (
                    'Searching…'
                  ) : row.match ? (
                    <>
                      → {nameOf(row.match.sourceId)}
                      {row.manual ? (
                        ' · chosen by hand'
                      ) : row.match.score < 1 ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          {' '}
                          · close match: “{row.match.title}”
                        </span>
                      ) : null}
                    </>
                  ) : (
                    'Not found in any chosen source'
                  )}
                </p>
              </div>
              <RowStatus row={row} />
              {!running && settled && row.run.state !== 'done' && (
                <div className="flex shrink-0 items-center gap-1">
                  {row.skipped ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => bulkMigration.setSkipped(row.manga.id, false)}
                    >
                      <Undo2 size={14} className="mr-1" aria-hidden="true" /> Include
                    </Button>
                  ) : (
                    <>
                      {row.match ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Preview the match for ${row.manga.title}`}
                          onClick={() => setDialog({ row, search: false })}
                        >
                          <Eye size={14} className="mr-1" aria-hidden="true" /> Preview
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Choose a match for ${row.manga.title} by hand`}
                          onClick={() => setDialog({ row, search: true })}
                        >
                          <Search size={14} className="mr-1" aria-hidden="true" /> Choose
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Skip ${row.manga.title}`}
                        onClick={() => bulkMigration.setSkipped(row.manga.id, true)}
                      >
                        Skip
                      </Button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {dialog && (
        <MatchDialog
          manga={dialog.row.manga}
          match={dialog.row.match}
          sources={(targetOrder.length ? targetOrder : targets.map((source) => source.id)).map(
            (id) => ({ id, name: nameOf(id) }),
          )}
          startWithSearch={dialog.search}
          onUse={(found) => bulkMigration.chooseMatch(dialog.row.manga.id, found)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function RowStatus({ row }: { row: BulkRow }) {
  const { run } = row;
  if (row.search === 'searching' || run.state === 'running')
    return (
      <span
        className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {run.state === 'running' && <span className="hidden sm:inline">{run.label}</span>}
      </span>
    );
  if (run.state === 'done')
    return (
      <Link
        href={`/manga/${encodeURIComponent(run.targetId)}`}
        className="flex shrink-0 items-center gap-1 text-xs text-primary"
      >
        <Check size={14} aria-hidden="true" /> Migrated
      </Link>
    );
  if (run.state === 'partial')
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
        <AlertCircle size={14} aria-hidden="true" />
        {run.failed} chapter{run.failed === 1 ? '' : 's'} failed; original kept
      </span>
    );
  if (run.state === 'failed')
    return (
      <span
        className="flex shrink-0 items-center gap-1 text-xs text-destructive"
        title={run.message}
      >
        <AlertCircle size={14} aria-hidden="true" /> Failed
      </span>
    );
  return null;
}
