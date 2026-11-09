'use client';

import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent, useMemo } from 'react';
import { toast } from '@/hooks/use-toast';
import {
  exportReadingDataFromServer,
  previewRestore as previewServerRestore,
  startReplaceRestore,
  ApiError,
} from '@projekt-manga/api-client';
import { replaceBackupBodySchema, RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';
import {
  savePendingRestore,
  clearPendingRestore,
  markRestoreAccepted,
  getPendingRestore,
} from '@/lib/restore-job';
import { parseBackup, previewBackupMerge, type BackupPayload } from '@/lib/backup-validation';
import { useHistory } from '@/lib/shared-queries';
import { ChangePasswordField } from '@/components/settings/change-password-field';
import { Panel, Field, Group, ActionButton, Toggle } from '@/components/settings/field-controls';
import { INCOGNITO_MODE } from '@/lib/incognito';
import { DesktopPrivacyControls } from '@/components/settings/desktop-privacy-controls';
import { actions, setState } from '@/lib/app-store';
import { APP_STATE_STORAGE_KEY } from '@/lib/theme';
import { useCurrentUser, sessionActions } from '@/lib/session-resource';
import { WipeDataDialog } from '@/components/settings/wipe-data-dialog';
import { ContentPrivacyControls } from '@/components/discover/content-privacy';
import { profileSettingsForExport, profileSettingsForImport } from '@/lib/profile-settings';
import { queryClient, queryKeys } from '@/lib/query-client';
import { useMangaLibrary } from '@/lib/library-store';
import { AutomaticBackups } from '@/components/settings/automatic-backups';
import { MihonImport } from '@/components/settings/mihon-import';
import type { ReadingDataExport } from '@projekt-manga/types';
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

/** Saves a JSON document through a temporary link — browsers have no other way to hand a
 * generated file to the reader. */
function saveJson(payload: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  // Must be attached before click(): Firefox ignores clicks on detached anchors.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // click() only starts the download; revoking in the same tick can cancel it. Deferring one
  // tick lets the browser take over the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** This profile's preferences, in the shape a restore reads back. Only the browser has
 * them, so they are merged into the server's export here. */
function exportableSettings(owner: string) {
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
}

/** Everything the app holds about you, in one file: the library, per-title shelf and
 * bookmark state, reading history, and the download queue, built by the server. Local
 * preferences ride along so a restore can put the app back the way it was. */
async function exportReadingData(owner: string) {
  const verifyOwner = () => {
    if (
      (queryClient.getQueryData<{ id: string } | null>(queryKeys.session)?.id ?? 'anonymous') !==
      owner
    )
      throw new Error('The account changed. Export again from the current profile.');
  };
  verifyOwner();
  const payload = await exportReadingDataFromServer(owner);
  verifyOwner();
  saveJson(
    { ...payload, settings: exportableSettings(owner) },
    `projekt-manga-export-${new Date().toISOString().slice(0, 10)}.json`,
  );
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
  const [serverPreview, setServerPreview] = useState<Awaited<
    ReturnType<typeof previewServerRestore>
  > | null>(null);
  const [serverPreviewMode, setServerPreviewMode] = useState<RestoreMode | null>(null);
  const [serverPreviewError, setServerPreviewError] = useState<string | null>(null);

  // What a merge would keep: only asked for once there's a backup to compare with.
  const historyPreview = useHistory({ enabled: !!backup });
  const historyPreviewUnavailable = !!backup && historyPreview.isError;
  const currentHistory = useMemo(
    () =>
      backup && historyPreview.data
        ? historyPreview.data.map(({ source, manga_slug, chapter_id, source_chapter_key }) => ({
            source,
            manga_slug,
            chapter_id,
            source_chapter_key,
          }))
        : null,
    [backup, historyPreview.data],
  );

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
    exportReadingData(user?.id ?? 'anonymous')
      .then(() => toast({ description: 'Export downloaded.' }))
      .catch(() => toast({ description: "Couldn't export your data — try again." }))
      .finally(() => setExporting(false));
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
      .then((text) => JSON.parse(text) as unknown)
      .then(openRestore, () => toast({ description: "Couldn't read that export." }));
  };

  /** Validates a backup — an imported file or a server backup — and opens the restore
   * preview for it. Nothing is applied until the dialog is confirmed. */
  const openRestore = (raw: unknown) =>
    Promise.resolve()
      .then(() => parseBackup(raw))
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

  /** A server backup carries no preferences, so this profile's current ones are added to
   * the download, as with a manual export. */
  const downloadServerBackup = (payload: ReadingDataExport, fileName: string) => {
    const owner = user?.id ?? 'anonymous';
    saveJson({ ...payload, settings: payload.settings ?? exportableSettings(owner) }, fileName);
  };

  const restore = (mode: RestoreMode, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!backup || restoring || sessionLoading) return;
    setRestoring(true);
    const jobId = crypto.randomUUID();
    const recoveryExport =
      mode === 'replace'
        ? exportReadingData(user?.id ?? 'anonymous').catch(() => {
            throw new Error("Couldn't prepare a recovery export. Your data was not changed.");
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
        markRestoreAccepted(jobId);
        return null;
      })
      .then((result) => {
        if (!result) {
          toast({
            description:
              'Restoring in the background. Keep reading if you like: anything you read meanwhile is kept, and the library refreshes when it finishes.',
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
        // The upload may still have arrived; give the server its grace period from now.
        else markRestoreAccepted(jobId);
        toast({
          description: error instanceof Error ? error.message : "Couldn't restore that export.",
        });
      })
      .finally(() => setRestoring(false));
  };

  return (
    <div className="space-y-6">
      <Panel title="Private reading" subtitle="What reading leaves behind on this device">
        <Field
          label="Incognito mode"
          hint="No history, saved progress or tracker updates while it's on; also the mask in the header"
        >
          <Toggle settingKey={INCOGNITO_MODE} />
        </Field>
        <DesktopPrivacyControls />
      </Panel>
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
          hint="Library, history and preferences as JSON, without CBZ files"
        >
          <ActionButton onClick={requestExport} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Download export'}
          </ActionButton>
        </Field>

        <Group label="Reset" />
        <Field
          label="Reset preferences"
          hint="Theme, reader and layout options; your library is kept"
        >
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
              >
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
        <Field label="Wipe selected data" hint="Remove library entries, history or downloads">
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
        <Field label="Import a backup" hint="Merge with or replace your current data">
          <>
            <input
              ref={importInput}
              type="file"
              accept="application/json,.json"
              onChange={readBackup}
              className="hidden"
            />
            <button
              type="button"
              ref={restoreTrigger}
              onClick={chooseBackup}
              disabled={restorePending}
              className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
            >
              Choose export
            </button>
          </>
        </Field>
        {!sessionLoading && (
          <MihonImport
            owner={user?.id ?? 'anonymous'}
            expectedUserId={user?.id ?? null}
            disabled={restorePending}
          />
        )}
        {!sessionLoading && (
          <AutomaticBackups
            owner={user?.id ?? 'anonymous'}
            disabled={restorePending}
            onRestore={(payload) => void openRestore(payload)}
            onDownload={downloadServerBackup}
          />
        )}
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
                        </dl>
                        {serverPreview.catalogUpdateExamples.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Updated shared catalog titles:{' '}
                            {serverPreview.catalogUpdateExamples.join(', ')}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          Read-only estimate from the current server state.
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
                </div>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
              {!confirmReplace && (
                <button
                  type="button"
                  onClick={(event) => restore('merge', event)}
                  disabled={
                    restoring ||
                    sessionLoading ||
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
                    (serverPreviewError === null && serverPreviewMode !== 'replace')
                  }
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Confirm replace
                </AlertDialogAction>
              ) : (
                <button
                  type="button"
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
        {user && <ChangePasswordField />}
        {user ? (
          <Field label="Delete account" hint="Permanently deletes your account and its data">
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
                <button
                  type="button"
                  className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20"
                >
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
          <Field label="Delete account" hint="Sign in from the Profile tab first" disabled>
            <span className="text-xs text-muted-foreground">Not applicable</span>
          </Field>
        )}
      </Panel>
    </div>
  );
}
