'use client';

import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { toast } from '@/hooks/use-toast';
import {
  getAllDownloads,
  getHistory,
  getLibraryState,
  getManga,
  getMangaDetailsById,
  previewRestore as previewServerRestore,
  startReplaceRestore,
  ApiError,
} from '@projekt-manga/api-client';
import { replaceBackupBodySchema, RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';
import { savePendingRestore, clearPendingRestore, getPendingRestore } from '@/lib/restore-job';
import { parseBackup, previewBackupMerge, type BackupPayload } from '@/lib/backup-validation';
import { Panel, Field, Group, ActionButton } from '@/components/settings/field-controls';
import { actions, setState } from '@/lib/app-store';
import { APP_STATE_STORAGE_KEY } from '@/lib/theme';
import { useCurrentUser, sessionActions } from '@/lib/session-resource';
import { WipeDataDialog } from '@/components/settings/wipe-data-dialog';
import { ContentPrivacyControls } from '@/components/discover/content-privacy';
import { profileSettingsForExport, profileSettingsForImport } from '@/lib/profile-settings';
import { queryClient, queryKeys } from '@/lib/query-client';
import { useMangaLibrary } from '@/lib/library-store';
import { mapConcurrent } from '@/lib/map-concurrent';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

/** Everything the app holds about you, in one file: the library, per-title shelf and
 * bookmark state, reading history, and the download queue. Local preferences ride along
 * so a restore can put the app back the way it was. */
/** Detail fetches in flight at once; a large library would otherwise fire hundreds together. */
const EXPORT_CONCURRENCY = 6;

async function exportReadingData(
  owner: string,
  onProgress?: (done: number, total: number) => void,
) {
  const verifyOwner = () => {
    if (
      (queryClient.getQueryData<{ id: string } | null>(queryKeys.session)?.id ?? 'anonymous') !==
      owner
    )
      throw new Error('The account changed. Export again from the current profile.');
  };
  verifyOwner();
  const [libraryManga, library, history, downloads] = await Promise.all([
    getManga(),
    getLibraryState(),
    getHistory(),
    getAllDownloads(),
  ]);
  // A list row does not carry description, status, or chapter metadata, so an export of
  // those rows alone could never be restored through the validated add-manga endpoint.
  let fetched = 0;
  const manga = await mapConcurrent(libraryManga, EXPORT_CONCURRENCY, async (entry) => {
    const details = await getMangaDetailsById(entry.id);
    onProgress?.(++fetched, libraryManga.length);
    return details;
  });
  verifyOwner();
  const settings = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(APP_STATE_STORAGE_KEY) ?? 'null');
      return stored
        ? {
            ...stored,
            profileOwner: owner,
            settings: profileSettingsForExport(stored.settings ?? {}, owner),
          }
        : null;
    } catch {
      return null;
    }
  })();

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 2,
    manga,
    library,
    history,
    downloads,
    settings,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `projekt-manga-export-${new Date().toISOString().slice(0, 10)}.json`;
  // Must be attached before click(): Firefox ignores clicks on detached anchors.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // click() only starts the download; revoking in the same tick can cancel it. Deferring one
  // tick lets the browser take over the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type RestoreMode = 'merge' | 'replace';

function importableSettings(
  value: BackupPayload['settings'],
  owner: string,
): Record<string, string | number | boolean> {
  const raw = value?.settings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const settings = Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === 'string' ||
        typeof entry[1] === 'number' ||
        typeof entry[1] === 'boolean',
    ),
  );
  return profileSettingsForImport(
    settings,
    owner,
    typeof value.profileOwner === 'string' ? value.profileOwner : undefined,
  );
}

export function PrivacyPanel() {
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [backup, setBackup] = useState<BackupPayload | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);
  const restoreTrigger = useRef<HTMLButtonElement | null>(null);
  const { user, loading: sessionLoading } = useCurrentUser();
  const { manga: currentLibrary, loading: libraryLoading } = useMangaLibrary();
  const [currentHistory, setCurrentHistory] = useState<Array<{
    source: string;
    manga_slug: string;
    chapter_id?: string;
  }> | null>(null);
  const [historyPreviewUnavailable, setHistoryPreviewUnavailable] = useState(false);
  const [serverPreview, setServerPreview] = useState<Awaited<
    ReturnType<typeof previewServerRestore>
  > | null>(null);
  const [serverPreviewMode, setServerPreviewMode] = useState<RestoreMode | null>(null);
  const [serverPreviewError, setServerPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!backup || sessionLoading) {
      setCurrentHistory(null);
      setHistoryPreviewUnavailable(false);
      return;
    }
    const controller = new AbortController();
    setCurrentHistory(null);
    setHistoryPreviewUnavailable(false);
    getHistory(controller.signal)
      .then((entries) => {
        if (!controller.signal.aborted)
          setCurrentHistory(
            entries.map(({ source, manga_slug, chapter_id }) => ({
              source,
              manga_slug,
              chapter_id,
            })),
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryPreviewUnavailable(true);
      });
    return () => controller.abort();
  }, [backup, sessionLoading, user?.id]);

  useEffect(() => {
    if (!backup || !restoreOpen || sessionLoading) {
      setServerPreview(null);
      setServerPreviewMode(null);
      setServerPreviewError(null);
      return;
    }
    const controller = new AbortController();
    setServerPreview(null);
    setServerPreviewMode(null);
    setServerPreviewError(null);
    const mode: RestoreMode = confirmReplace ? 'replace' : 'merge';
    void previewServerRestore(
      {
        expectedUserId: user?.id ?? null,
        version: backup.version,
        manga: backup.manga,
        library: backup.library,
        history: backup.history,
        mode,
      },
      controller.signal,
    ).then(
      (preview) => {
        if (!controller.signal.aborted) {
          setServerPreview(preview);
          setServerPreviewMode(mode);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setServerPreviewError(
            error instanceof Error ? error.message : 'Server comparison failed.',
          );
        }
      },
    );
    return () => controller.abort();
  }, [backup, confirmReplace, restoreOpen, sessionLoading, user?.id]);

  useEffect(() => {
    if (sessionLoading) return;
    const refresh = () =>
      setRestorePending(getPendingRestore()?.owner === (user?.id ?? 'anonymous'));
    refresh();
    window.addEventListener('projekt-manga-restore-started', refresh);
    window.addEventListener('projekt-manga-restore-finished', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('projekt-manga-restore-started', refresh);
      window.removeEventListener('projekt-manga-restore-finished', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [sessionLoading, user?.id]);

  // AlertDialogAction closes the dialog on click, which would hide the "Deleting…" state before
  // the request settles. The dialog is controlled and closed only after the request finishes.
  const deleteAccount = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!deletePassword) {
      setDeleteError('Enter your password to confirm.');
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    sessionActions
      .deleteAccount(deletePassword)
      .then(() => {
        toast({ description: 'Account deleted.' });
        window.location.reload();
      })
      .catch((error: unknown) => {
        setDeleting(false);
        // A wrong password keeps the dialog open so it can be retyped.
        if (error instanceof ApiError && error.status === 401) {
          setDeleteError('That password is not correct.');
          return;
        }
        toast({ description: "Couldn't delete the account — try again." });
        setDeleteDialogOpen(false);
      });
  };

  const requestExport = () => {
    if (exporting) return;
    setExporting(true);
    exportReadingData(user?.id ?? 'anonymous', (done, total) => setExportProgress({ done, total }))
      .then(() => toast({ description: 'Export downloaded.' }))
      .catch(() => toast({ description: "Couldn't export your data — try again." }))
      .finally(() => {
        setExporting(false);
        setExportProgress(null);
      });
  };

  const resetPreferences = () => {
    actions.resetAll();
    toast({
      description: 'Preferences reset to defaults. Your library and history are untouched.',
    });
  };

  const mergePreview = backup
    ? previewBackupMerge(backup, currentLibrary, currentHistory ?? [])
    : null;
  const serverPreviewBlocksRestore =
    serverPreviewMode === (confirmReplace ? 'replace' : 'merge') &&
    (serverPreview?.chapterIdentityConflicts ?? 0) > 0;

  const chooseBackup = () => importInput.current?.click();

  const readBackup = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset immediately so choosing the same file after correcting it still fires change.
    event.target.value = '';
    if (!file) return;
    if (file.size > RESTORE_UPLOAD_LIMIT_BYTES) {
      toast({ description: 'That export is too large to load safely in the browser.' });
      return;
    }
    void file
      .text()
      .then((text) => parseBackup(JSON.parse(text)))
      .then((parsed) => {
        setBackup(parsed);
        setConfirmReplace(false);
        setRestoreOpen(true);
      })
      .catch((error) =>
        toast({
          description: error instanceof Error ? error.message : "Couldn't read that export.",
        }),
      );
  };

  const restore = (mode: RestoreMode, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (
      !backup ||
      restoring ||
      sessionLoading ||
      (serverPreviewMode === mode && (serverPreview?.chapterIdentityConflicts ?? 0) > 0)
    )
      return;
    setRestoring(true);
    const jobId = crypto.randomUUID();
    const recoveryExport =
      mode === 'replace'
        ? exportReadingData(user?.id ?? 'anonymous').catch(() => {
            throw new Error('Could not prepare a recovery export. Your data was not changed.');
          })
        : Promise.resolve();
    void recoveryExport
      .then(async () => {
        const parsed = replaceBackupBodySchema.safeParse({
          jobId,
          mode,
          expectedUserId: user?.id ?? null,
          version: backup.version,
          manga: backup.manga,
          library: backup.library,
          history: backup.history,
        });
        if (!parsed.success)
          throw new Error('This export cannot be restored safely. No data was changed.');
        if (new Blob([JSON.stringify(parsed.data)]).size > RESTORE_UPLOAD_LIMIT_BYTES) {
          throw new Error('The restore request exceeds the 10 MiB limit. No data was changed.');
        }
        savePendingRestore({
          id: jobId,
          mode,
          owner: user?.id ?? 'anonymous',
          settings: importableSettings(backup.settings, user?.id ?? 'anonymous'),
          skippedDownloads: backup.downloads?.length ?? 0,
          startedAt: Date.now(),
        });
        await startReplaceRestore(parsed.data);
        return null;
      })
      .then((result) => {
        if (!result) {
          toast({
            description:
              'Restore is running. Library actions stay blocked until it finishes and your data refreshes.',
          });
          setRestoreOpen(false);
          setBackup(null);
          return;
        }
        const { restoredManga, restoredHistory, restoredProgress, skippedDownloads } = result;
        const downloadNote = skippedDownloads > 0 ? ' Downloaded files were not restored.' : '';
        toast({
          description: `Restored ${restoredManga} title${restoredManga === 1 ? '' : 's'}, ${restoredProgress} saved positions, and ${restoredHistory} history entries.${downloadNote}`,
        });
        setRestoreOpen(false);
        setBackup(null);
      })
      .catch((error) => {
        if (!(error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout')))
          clearPendingRestore(jobId);
        toast({
          description: error instanceof Error ? error.message : "Couldn't restore that export.",
        });
      })
      .finally(() => setRestoring(false));
  };

  return (
    <div className="space-y-6">
      <Panel title="Content privacy" subtitle="Independent preferences for this profile">
        <ContentPrivacyControls />
      </Panel>
      <Panel title="Your data" subtitle="Browser preferences and self-hosted server data">
        <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-xs text-muted-foreground">
          Projekt Manga runs against your configured server. Your library, reading history, and
          downloads are stored there; preferences are kept in this browser. Desktop also keeps an
          offline copy. There is no analytics or telemetry in this build.
          <p className="mt-2">
            Exports include the current profile's preferences. Importing applies those preferences
            to the selected profile and keeps other profiles' preferences.
          </p>
        </div>

        <Field
          label="Export your data"
          hint="A JSON file with your library, shelf state, history, downloads, and preferences. Local CBZ archives and their image files are excluded; keep your original CBZ files separately."
        >
          <ActionButton onClick={requestExport} disabled={exporting}>
            {exporting
              ? `Exporting…${exportProgress ? ` ${exportProgress.done}/${exportProgress.total}` : ''}`
              : 'Download export'}
          </ActionButton>
        </Field>

        <Group label="Reset" />
        <Field
          label="Reset preferences"
          hint="Theme, reader options, categories, and layout — your library and history are kept"
        >
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent">
                Reset preferences
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all preferences?</AlertDialogTitle>
                <AlertDialogDescription>
                  Theme, accent, reader settings, custom categories, and layout choices go back to
                  their defaults. Your library, reading history, and downloaded chapters are not
                  affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={resetPreferences}>Reset</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </Field>
        <Field
          label="Wipe selected data"
          hint="Choose library entries, reading history, or downloaded chapters to remove"
        >
          <WipeDataDialog />
        </Field>
      </Panel>

      <Panel title="Restore and account" subtitle="Bring back a previous export safely">
        {restorePending && (
          <p
            role="status"
            className="rounded-lg border border-border/60 bg-accent/30 px-3 py-2 text-xs text-foreground"
          >
            A backup restore is running in the background. You can leave this page; the result will
            appear when it finishes.
          </p>
        )}
        <Field
          label="Import a backup"
          hint="Choose merge to preserve current reads, or replace after a second confirmation. Downloaded image files are not in JSON exports."
        >
          <>
            <input
              ref={importInput}
              type="file"
              accept="application/json,.json"
              onChange={readBackup}
              className="hidden"
            />
            <button
              ref={restoreTrigger}
              onClick={chooseBackup}
              disabled={restorePending}
              className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
            >
              Choose export
            </button>
          </>
        </Field>
        <AlertDialog open={restoreOpen} onOpenChange={(open) => !restoring && setRestoreOpen(open)}>
          <AlertDialogContent
            className="max-h-[90vh] overflow-y-auto"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              restoreTrigger.current?.focus();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Restore this backup?</AlertDialogTitle>
              <AlertDialogDescription>
                Merge adds titles and history that do not already exist. Replace removes your
                current library membership and reading history in one server transaction before
                restoring this export. A recovery export of your current data starts first. Neither
                option recreates downloaded image files.
              </AlertDialogDescription>
              {backup && (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/50 p-3 text-sm">
                  <dt>Titles</dt>
                  <dd className="text-right">{backup.manga.length}</dd>
                  <dt>Chapters</dt>
                  <dd className="text-right">
                    {backup.manga.reduce((total, title) => total + title.chapters.length, 0)}
                  </dd>
                  <dt>Library states</dt>
                  <dd className="text-right">{backup.library.length}</dd>
                  <dt>History entries</dt>
                  <dd className="text-right">{backup.history.length}</dd>
                  <dt>Downloaded files skipped</dt>
                  <dd className="text-right">{backup.downloads?.length ?? 0}</dd>
                </dl>
              )}
              {backup && (
                <div className="mt-3 space-y-3 rounded-md border border-border/60 p-3 text-sm">
                  <section>
                    <h3 className="font-semibold">Merge estimate</h3>
                    {libraryLoading ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Checking the current library…
                      </p>
                    ) : mergePreview ? (
                      <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <dt>Matching titles retained as-is</dt>
                        <dd className="text-right">{mergePreview.matchingTitles}</dd>
                        <dt>New titles added</dt>
                        <dd className="text-right">{mergePreview.addedTitles}</dd>
                        <dt>Incoming chapters skipped for matching titles</dt>
                        <dd className="text-right">{mergePreview.skippedChapters}</dd>
                        <dt>Incoming shelf states skipped for matching titles</dt>
                        <dd className="text-right">{mergePreview.skippedLibraryStates}</dd>
                        <dt>History retained by duplicate key</dt>
                        <dd className="text-right">
                          {currentHistory ? mergePreview.retainedHistory : 'Unknown'}
                        </dd>
                        <dt>History entries to add</dt>
                        <dd className="text-right">
                          {currentHistory ? mergePreview.addedHistory : 'Unknown'}
                        </dd>
                      </dl>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Checking current reading history…
                      </p>
                    )}
                    {!libraryLoading && !currentHistory && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {historyPreviewUnavailable
                          ? 'History overlap could not be checked; the server will resolve duplicate history during restore.'
                          : 'Checking current reading history…'}
                      </p>
                    )}
                  </section>
                  <section>
                    <h3 className="font-semibold">Replace outcome</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Replace removes current library membership and history, then restores the
                      {` ${backup.manga.length} `}exported titles and {backup.history.length}{' '}
                      history entries. Existing shared catalog rows are updated in place; downloaded
                      files are skipped.
                      {currentHistory &&
                        ` Current membership includes ${currentLibrary.length} titles and ${currentHistory.length} history entries.`}
                    </p>
                  </section>
                  <section aria-live="polite">
                    <h3 className="font-semibold">Server catalog comparison</h3>
                    {serverPreview ? (
                      <>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Compared for {serverPreviewMode} mode.
                        </p>
                        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          <dt>Catalog titles found</dt>
                          <dd className="text-right">{serverPreview.matchingTitles}</dd>
                          <dt>Titles to import in this mode</dt>
                          <dd className="text-right">{serverPreview.importedTitles}</dd>
                          <dt>Shared catalog rows that differ</dt>
                          <dd className="text-right">{serverPreview.catalogRowsUpdated}</dd>
                          <dt>Chapter identity conflicts</dt>
                          <dd className="text-right">{serverPreview.chapterIdentityConflicts}</dd>
                        </dl>
                        {serverPreview.catalogUpdateExamples.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Updated shared catalog titles:{' '}
                            {serverPreview.catalogUpdateExamples.join(', ')}
                          </p>
                        )}
                        {serverPreview.chapterIdentityConflictExamples.length > 0 && (
                          <ul className="mt-1 list-disc pl-5 text-xs text-destructive">
                            {serverPreview.chapterIdentityConflictExamples.map((conflict) => (
                              <li key={conflict}>{conflict}</li>
                            ))}
                          </ul>
                        )}
                        {serverPreviewBlocksRestore && (
                          <p role="alert" className="mt-2 text-xs font-medium text-destructive">
                            Restore is blocked because chapter IDs in this backup belong to other
                            titles. Remove or correct the conflicting entries, then preview the
                            backup again.
                          </p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          Read-only estimate from the current server state. The restore transaction
                          rechecks conflicts when it runs.
                        </p>
                      </>
                    ) : serverPreviewError ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Server comparison unavailable: {serverPreviewError}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Comparing with the current server catalog…
                      </p>
                    )}
                  </section>
                  <p className="text-xs text-muted-foreground">
                    If an imported chapter ID belongs to a different title on the server, the
                    transaction is rejected and your existing data is retained.
                  </p>
                </div>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
              {!confirmReplace && (
                <button
                  onClick={(event) => restore('merge', event)}
                  disabled={
                    restoring ||
                    sessionLoading ||
                    serverPreviewBlocksRestore ||
                    (serverPreviewError === null && serverPreviewMode !== 'merge')
                  }
                  className="rounded-md border border-border/60 px-3 py-2 text-sm font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                >
                  {restoring ? 'Restoring…' : 'Merge backup'}
                </button>
              )}
              {confirmReplace ? (
                <AlertDialogAction
                  onClick={(event) => restore('replace', event)}
                  disabled={
                    restoring ||
                    sessionLoading ||
                    serverPreviewBlocksRestore ||
                    (serverPreviewError === null && serverPreviewMode !== 'replace')
                  }
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Confirm replace
                </AlertDialogAction>
              ) : (
                <button
                  onClick={() => setConfirmReplace(true)}
                  disabled={restoring || sessionLoading}
                  className="rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:opacity-50"
                >
                  Replace current data…
                </button>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {user ? (
          <Field
            label="Delete account"
            hint="Permanently removes your account, library, progress, and reading history from the server"
          >
            <AlertDialog
              open={deleteDialogOpen}
              onOpenChange={(open) => {
                if (deleting) return;
                setDeleteDialogOpen(open);
                setDeletePassword('');
                setDeleteError(null);
              }}
            >
              <AlertDialogTrigger asChild>
                <button className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20">
                  Delete account
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes {user.email}, your synced library, reading progress,
                    and history from the server. This can&apos;t be undone. Any device signed into
                    this account keeps its own local data until it syncs again.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <label className="grid gap-1.5 text-xs text-muted-foreground">
                  Password
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={deletePassword}
                    onChange={(event) => {
                      setDeletePassword(event.target.value);
                      setDeleteError(null);
                    }}
                    aria-invalid={deleteError ? true : undefined}
                    aria-describedby={deleteError ? 'delete-account-error' : undefined}
                    className="rounded-lg border border-border/60 bg-surface/40 px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
                  />
                </label>
                {deleteError && (
                  <p id="delete-account-error" role="alert" className="text-xs text-destructive">
                    {deleteError}
                  </p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={deleteAccount} disabled={deleting}>
                    {deleting ? 'Deleting…' : 'Delete account'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </Field>
        ) : (
          <Field
            label="Delete account"
            hint="No account signed in — create one in the Profile tab first"
            disabled
          >
            <span className="text-xs text-muted-foreground">Not applicable</span>
          </Field>
        )}
      </Panel>
    </div>
  );
}
