'use client';

import { useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { SelectMenu } from '@/components/ui/select-menu';
import {
  ApiError,
  getSources,
  getSourceKeysFromUrls,
  previewRestore,
  searchSourceMangaPage,
  startReplaceRestore,
  type RestorePreview,
} from '@projekt-manga/api-client';
import { replaceBackupBodySchema, RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';
import { toast } from '@/hooks/use-toast';
import { Field } from '@/components/settings/field-controls';
import { parseBackup } from '@/lib/backup-validation';
import { savePendingRestore, clearPendingRestore, markRestoreAccepted } from '@/lib/restore-job';
import {
  buildMihonImport,
  findTitlesInSources,
  readMihonBackupFile,
  resolveMihonKeys,
  summariseSources,
  type InstalledSource,
  type MihonBackup,
  type MihonImport as BuiltImport,
  type MihonSourceSummary,
  type TitleSearchResult,
} from '@/lib/mihon-backup';
import { useMigrationPreferences } from '@/lib/migration-state';
import { SourceOrderList } from '@/components/settings/source-order-list';
import { clearMihonImportExtras, saveMihonImportExtras } from '@/lib/mihon-backup/extras';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** Compressed backups above this are refused before they are read. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

type Step =
  | { kind: 'closed' }
  | {
      kind: 'map';
      backup: MihonBackup;
      installed: InstalledSource[];
      sources: MihonSourceSummary[];
    }
  | {
      kind: 'review';
      built: BuiltImport;
      backup: MihonBackup;
      installed: InstalledSource[];
      search: TitleSearchResult | null;
      preview: RestorePreview | null;
      previewError: string | null;
    };

function initialChoices(sources: MihonSourceSummary[]): Map<string, string | null> {
  return new Map(
    sources.map((source) => [
      source.id,
      source.match.kind === 'matched' ? source.match.sourceId : null,
    ]),
  );
}

const sourceLabel = (source: InstalledSource) => `${source.name} (${source.lang})`;

const searchInSource = (sourceId: string, query: string, signal?: AbortSignal) =>
  searchSourceMangaPage(sourceId, { query, limit: 20 }, signal).then((page) => page.items);

/** Titles listed under a heading in the review, before the rest are counted. */
const REVIEW_LIST_LIMIT = 50;

/**
 * Settings › Privacy › Backups: imports a Mihon/Tachiyomi backup. The file is decoded here,
 * its sources are matched to installed ones, and the result goes through the same restore
 * job as a Projekt Manga backup (merge only), after a preview and a confirmation.
 */
export function MihonImport({
  owner,
  expectedUserId,
  disabled,
}: {
  owner: string;
  expectedUserId: string | null;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'closed' });
  const [choices, setChoices] = useState<Map<string, string | null>>(new Map());
  const [unmatched, setUnmatched] = useState<'skip' | 'import'>('skip');
  // Sources searched by title, in order, for titles whose own source has no match: one
  // order for every such source, unless a source is given its own.
  const [defaultOrder, setDefaultOrder] = useState<string[]>([]);
  const [customOrders, setCustomOrders] = useState<Map<string, string[]>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const searching = useRef<AbortController | null>(null);
  const [migration] = useMigrationPreferences();

  const close = () => {
    if (busy) return;
    setStep({ kind: 'closed' });
  };

  const searchOrders = () => {
    const orders = new Map<string, string[]>();
    if (step.kind !== 'map') return orders;
    for (const source of step.sources)
      if (!choices.get(source.id))
        orders.set(source.id, customOrders.get(source.id) ?? defaultOrder);
    return orders;
  };

  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so choosing the same file again still fires change.
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast({ description: 'That backup is too large to import.' });
      return;
    }
    setBusy('Reading backup…');
    void Promise.all([readMihonBackupFile(file), getSources()])
      .then(([backup, installed]) => {
        const sources = summariseSources(backup, installed);
        setChoices(initialChoices(sources));
        setUnmatched('skip');
        // Start from the order the reader uses for migrations.
        setDefaultOrder(
          migration.sourceOrder.filter((id) => installed.some((source) => source.id === id)),
        );
        setCustomOrders(new Map());
        setStep({ kind: 'map', backup, installed, sources });
      })
      .catch((error: unknown) =>
        toast({
          description:
            error instanceof Error && error.name === 'MihonBackupError'
              ? error.message
              : "Couldn't read that backup.",
        }),
      )
      .finally(() => setBusy(null));
  };

  const prepare = () => {
    if (step.kind !== 'map' || busy) return;
    const { backup, installed } = step;
    const orders = searchOrders();
    const controller = new AbortController();
    searching.current = controller;
    setBusy('Matching chapters…');
    void resolveMihonKeys(backup, choices, getSourceKeysFromUrls, controller.signal)
      .then(async (keys) => {
        const search = [...orders.values()].some((order) => order.length)
          ? await findTitlesInSources(backup, choices, orders, searchInSource, {
              signal: controller.signal,
              onProgress: ({ done, total }) => setBusy(`Searching sources… ${done} of ${total}`),
            })
          : null;
        const built = buildMihonImport(backup, {
          sources: choices,
          keys,
          unmatched,
          found: search?.found,
        });
        if (built.payload.manga.length === 0 && built.payload.history.length === 0)
          throw new Error('Nothing in this backup can be imported with the current choices.');
        // The same checks a Projekt Manga backup gets before its preview.
        parseBackup(built.payload);
        setStep({
          kind: 'review',
          built,
          backup,
          installed,
          search,
          preview: null,
          previewError: null,
        });
        return previewRestore({ ...built.payload, mode: 'merge', expectedUserId }).then(
          (preview) =>
            setStep((current) =>
              current.kind === 'review' && current.built === built
                ? { ...current, preview }
                : current,
            ),
          (error: unknown) =>
            setStep((current) =>
              current.kind === 'review' && current.built === built
                ? {
                    ...current,
                    previewError:
                      error instanceof Error ? error.message : 'Server comparison failed.',
                  }
                : current,
            ),
        );
      })
      .catch((error: unknown) =>
        toast({
          description: controller.signal.aborted
            ? 'Search stopped. Nothing was imported.'
            : error instanceof Error
              ? error.message
              : "Couldn't prepare this import.",
        }),
      )
      .finally(() => {
        if (searching.current === controller) searching.current = null;
        setBusy(null);
      });
  };

  const confirm = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (step.kind !== 'review' || busy) return;
    const jobId = crypto.randomUUID();
    setBusy('Starting import…');
    void Promise.resolve()
      .then(async () => {
        const parsed = replaceBackupBodySchema.safeParse({
          ...step.built.payload,
          jobId,
          mode: 'merge',
          expectedUserId,
        });
        if (!parsed.success)
          throw new Error('This backup cannot be imported safely. No data was changed.');
        if (new Blob([JSON.stringify(parsed.data)]).size > RESTORE_UPLOAD_LIMIT_BYTES)
          throw new Error('The import exceeds the 10 MiB limit. No data was changed.');
        savePendingRestore({
          id: jobId,
          mode: 'merge',
          owner,
          settings: {},
          skippedDownloads: 0,
          startedAt: Date.now(),
        });
        saveMihonImportExtras(jobId, owner, step.built.extras);
        await startReplaceRestore(parsed.data);
        markRestoreAccepted(jobId);
      })
      .then(() => {
        toast({
          description:
            'Import is running. Categories and tracker links are added when it finishes.',
        });
        setStep({ kind: 'closed' });
      })
      .catch((error: unknown) => {
        if (!(
          error instanceof ApiError &&
          (error.kind === 'network' || error.kind === 'timeout')
        )) {
          clearPendingRestore(jobId);
          clearMihonImportExtras(jobId);
        } else {
          // The upload may still have arrived; give the server its grace period from now.
          markRestoreAccepted(jobId);
        }
        toast({
          description: error instanceof Error ? error.message : "Couldn't start the import.",
        });
      })
      .finally(() => setBusy(null));
  };

  const matchedTitles =
    step.kind === 'map'
      ? step.sources.reduce(
          (total, source) => total + (choices.get(source.id) ? source.titles : 0),
          0,
        )
      : 0;
  const totalTitles = step.kind === 'map' ? step.backup.manga.length : 0;
  const unmatchedSources =
    step.kind === 'map' ? step.sources.filter((source) => !choices.get(source.id)) : [];
  const searchedTitles = unmatchedSources.reduce(
    (total, source) =>
      total + ((customOrders.get(source.id) ?? defaultOrder).length ? source.titles : 0),
    0,
  );
  const sourceName = (installed: InstalledSource[], id: string) =>
    installed.find((source) => source.id === id)?.name ?? id;

  return (
    <>
      <Field
        label="Import from Mihon/Tachiyomi…"
        hint="A .tachibk or .proto.gz backup; added to your current library"
      >
        <>
          <input
            ref={input}
            type="file"
            accept=".tachibk,.gz,application/gzip,application/octet-stream"
            onChange={readFile}
            className="hidden"
          />
          <button
            type="button"
            ref={trigger}
            onClick={() => input.current?.click()}
            disabled={disabled || !!busy}
            className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
          >
            {busy && step.kind === 'closed' ? busy : 'Choose backup'}
          </button>
        </>
      </Field>
      <AlertDialog open={step.kind !== 'closed'} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent
          className="max-h-[90vh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          {step.kind === 'map' && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Import from Mihon/Tachiyomi</AlertDialogTitle>
                <AlertDialogDescription>
                  Each Mihon source is matched to an installed source by name. Titles from a source
                  with no match cannot sync chapters here.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/50 p-3 text-sm">
                <dt>Titles in backup</dt>
                <dd className="text-right">{totalTitles}</dd>
                <dt>Titles with a matched source</dt>
                <dd className="text-right">{matchedTitles}</dd>
                <dt>Titles with no matched source</dt>
                <dd className="text-right">{totalTitles - matchedTitles}</dd>
                <dt>Of those, searched for by name</dt>
                <dd className="text-right">{searchedTitles}</dd>
                <dt>Categories</dt>
                <dd className="text-right">{step.backup.categories.length}</dd>
              </dl>
              <ul className="space-y-2 text-sm" aria-label="Sources in this backup">
                {step.sources.map((source) => {
                  const options =
                    source.match.kind === 'ambiguous'
                      ? step.installed.filter((installed) =>
                          (source.match as { candidates: string[] }).candidates.includes(
                            installed.id,
                          ),
                        )
                      : step.installed;
                  const value = choices.get(source.id) ?? '';
                  return (
                    <li
                      key={source.id}
                      className="flex flex-col gap-1 rounded-md border border-border/60 p-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{source.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {' '}
                          · {source.titles} title{source.titles === 1 ? '' : 's'}
                          {source.match.kind === 'ambiguous' && !value
                            ? ' · choose a language'
                            : !value
                              ? ' · not installed'
                              : ''}
                        </span>
                      </span>
                      <SelectMenu
                        label={`Installed source for ${source.name}`}
                        className="w-full sm:w-48"
                        value={value}
                        disabled={!!busy}
                        onChange={(next) =>
                          setChoices((current) => new Map(current).set(source.id, next || null))
                        }
                        options={[
                          { value: '', label: 'No match' },
                          ...options.map((installed) => ({
                            value: installed.id,
                            label: sourceLabel(installed),
                          })),
                        ]}
                      />
                      {!value && (
                        <div className="basis-full space-y-1.5 sm:pt-1">
                          {customOrders.has(source.id) ? (
                            <>
                              <SourceOrderList
                                sources={step.installed}
                                value={customOrders.get(source.id)!}
                                disabled={!!busy}
                                label={`Search order for ${source.name}`}
                                onChange={(ids) =>
                                  setCustomOrders((current) => new Map(current).set(source.id, ids))
                                }
                              />
                              <button
                                type="button"
                                disabled={!!busy}
                                className="text-xs text-primary hover:underline disabled:opacity-50"
                                onClick={() =>
                                  setCustomOrders((current) => {
                                    const next = new Map(current);
                                    next.delete(source.id);
                                    return next;
                                  })
                                }
                              >
                                Use the default order
                              </button>
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {defaultOrder.length
                                ? `Searched by name in the default order (${defaultOrder.length} source${defaultOrder.length === 1 ? '' : 's'}).`
                                : 'Not searched in other sources.'}{' '}
                              <button
                                type="button"
                                disabled={!!busy}
                                className="text-primary hover:underline disabled:opacity-50"
                                onClick={() =>
                                  setCustomOrders((current) =>
                                    new Map(current).set(source.id, [...defaultOrder]),
                                  )
                                }
                              >
                                Choose sources for this one
                              </button>
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {unmatchedSources.length > 0 && (
                <section className="space-y-1.5 text-sm" aria-labelledby="mihon-default-order">
                  <h3 id="mihon-default-order" className="font-medium">
                    Search other sources by name
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Titles from a source with no match are looked up by name in these sources, top
                    first; the first close match is used. Hold a row and drag it to reorder.
                  </p>
                  <SourceOrderList
                    sources={step.installed}
                    value={defaultOrder}
                    disabled={!!busy}
                    onChange={setDefaultOrder}
                    label="Default search order"
                  />
                </section>
              )}
              <fieldset className="space-y-1 text-sm">
                <legend className="font-medium">Titles not found in any source</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mihon-unmatched"
                    checked={unmatched === 'skip'}
                    onChange={() => setUnmatched('skip')}
                  />
                  Skip them
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mihon-unmatched"
                    checked={unmatched === 'import'}
                    onChange={() => setUnmatched('import')}
                  />
                  Add them without chapters, to migrate to another source later
                </label>
              </fieldset>
              <AlertDialogFooter>
                {busy && searching.current ? (
                  <button
                    type="button"
                    onClick={() => searching.current?.abort()}
                    className="rounded-md border border-border/60 px-3 py-2 text-sm font-medium transition hover:bg-accent"
                  >
                    Stop
                  </button>
                ) : (
                  <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
                )}
                <button
                  type="button"
                  onClick={prepare}
                  disabled={!!busy}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ?? 'Continue'}
                </button>
              </AlertDialogFooter>
            </>
          )}
          {step.kind === 'review' && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Import this backup?</AlertDialogTitle>
                <AlertDialogDescription>
                  Titles are added to your current library; nothing already there is removed.
                  Chapters you have not touched are fetched from each source later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/50 p-3 text-sm">
                <dt>Library titles</dt>
                <dd className="text-right">{step.built.stats.libraryTitles}</dd>
                <dt>Found by name in another source</dt>
                <dd className="text-right">{step.built.stats.foundBySearch}</dd>
                <dt>Without a source, for migration</dt>
                <dd className="text-right">{step.built.stats.unmatchedImported}</dd>
                <dt>Skipped titles</dt>
                <dd className="text-right">{step.built.stats.unmatchedSkipped}</dd>
                <dt>Chapters with reading state</dt>
                <dd className="text-right">{step.built.stats.chaptersWithState}</dd>
                <dt>Matched by chapter number later</dt>
                <dd className="text-right">{step.built.stats.chaptersByNumber}</dd>
                <dt>History entries</dt>
                <dd className="text-right">{step.built.stats.history}</dd>
                <dt>Categories</dt>
                <dd className="text-right">{step.built.stats.categories}</dd>
                <dt>Tracker links</dt>
                <dd className="text-right">{step.built.stats.trackerLinks}</dd>
              </dl>
              {step.built.stats.guessedSlugs > 0 && (
                <p className="text-xs text-muted-foreground">
                  {step.built.stats.guessedSlugs} title
                  {step.built.stats.guessedSlugs === 1 ? '' : 's'} come from sources that cannot
                  read Mihon links; their address was guessed from the link and may need a migration
                  if chapters do not load.
                </p>
              )}
              {step.search && step.search.found.size > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">
                    Found by name ({step.search.found.size})
                  </summary>
                  <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-muted-foreground">
                    {[...step.search.found.entries()]
                      .slice(0, REVIEW_LIST_LIMIT)
                      .map(([index, found]) => (
                        <li key={index}>
                          {step.backup.manga[index].title} →{' '}
                          <span className="text-foreground">
                            {sourceName(step.installed, found.sourceId)}
                          </span>
                          {found.score < 1 && ` as “${found.title}”`}
                        </li>
                      ))}
                    {step.search.found.size > REVIEW_LIST_LIMIT && (
                      <li>…and {step.search.found.size - REVIEW_LIST_LIMIT} more</li>
                    )}
                  </ul>
                </details>
              )}
              {step.search && step.search.missing.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">
                    Not found in any listed source ({step.search.missing.length})
                  </summary>
                  <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-muted-foreground">
                    {step.search.missing.slice(0, REVIEW_LIST_LIMIT).map((index) => (
                      <li key={index}>{step.backup.manga[index].title}</li>
                    ))}
                    {step.search.missing.length > REVIEW_LIST_LIMIT && (
                      <li>…and {step.search.missing.length - REVIEW_LIST_LIMIT} more</li>
                    )}
                  </ul>
                </details>
              )}
              {step.search && step.search.failedSources.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {step.search.failedSources.map((id) => sourceName(step.installed, id)).join(', ')}{' '}
                  could not be searched for some titles; the next source in the order was tried.
                </p>
              )}
              {step.built.stats.foundBySearch > 0 && (
                <p className="text-xs text-muted-foreground">
                  Read chapters of titles found by name are matched by chapter number once their
                  chapters load.
                </p>
              )}
              {step.built.stats.trackerLinks > 0 && (
                <p className="text-xs text-muted-foreground">
                  Tracker links are only added for trackers connected in Settings › Trackers.
                </p>
              )}
              <section aria-live="polite" className="text-xs text-muted-foreground">
                {step.preview
                  ? `Server check: ${step.preview.matchingTitles} titles already known, ${step.preview.importedTitles} to import.`
                  : step.previewError
                    ? `Server comparison unavailable: ${step.previewError}`
                    : 'Comparing with the current server catalog…'}
              </section>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
                <button
                  type="button"
                  onClick={confirm}
                  disabled={!!busy || (!step.preview && !step.previewError)}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ?? 'Import'}
                </button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
