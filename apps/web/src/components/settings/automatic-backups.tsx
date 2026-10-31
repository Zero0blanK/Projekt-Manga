'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createBackupNow,
  getBackupFile,
  getBackupStatus,
  updateBackupConfig,
} from '@projekt-manga/api-client';
import type { BackupStatus, ReadingDataExport } from '@projekt-manga/types';
import { toast } from '@/hooks/use-toast';
import { Field, Group, ActionButton } from '@/components/settings/field-controls';

/** Optional desktop bridge, the same probe open-folder-button.tsx uses. */
type DesktopBridge = { openPath?: (path: string) => Promise<unknown> };
function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { desktop?: DesktopBridge }).desktop ?? null;
}

const INTERVAL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 6, label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Daily' },
  { value: 24 * 7, label: 'Weekly' },
];
const KEEP_OPTIONS = [3, 5, 7, 14, 30];

const selectClass =
  'h-8 min-w-40 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary/60 disabled:opacity-50';

function isBackupStatus(value: unknown): value is BackupStatus {
  const status = value as Partial<BackupStatus> | null;
  return (
    !!status &&
    typeof status.config?.intervalHours === 'number' &&
    typeof status.config.keep === 'number' &&
    Array.isArray(status.files)
  );
}

const formatDate = (iso: string) => new Date(iso).toLocaleString();
const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Server-written backups for the signed-in owner (or anonymous use): when the last one ran,
 * how often they run, and the files kept. Restoring one goes through the same preview
 * dialog as an imported file, so it is never applied without that confirmation.
 */
export function AutomaticBackups({
  owner,
  disabled,
  onRestore,
  onDownload,
}: {
  owner: string;
  /** A restore is already running, or the session is still loading. */
  disabled: boolean;
  onRestore: (payload: unknown) => void;
  onDownload: (payload: ReadingDataExport, fileName: string) => void;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      getBackupStatus(owner, signal).then(
        (next) => {
          if (signal?.aborted) return;
          // An older or different server can answer this route with another shape; show
          // the section as unavailable rather than letting it take down Privacy.
          if (!isBackupStatus(next)) {
            setUnavailable(true);
            return;
          }
          setStatus(next);
          setUnavailable(false);
        },
        () => {
          if (!signal?.aborted) setUnavailable(true);
        },
      ),
    [owner],
  );

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const run = (key: string, task: () => Promise<void>, failure: string) => {
    if (busy) return;
    setBusy(key);
    task()
      .catch((error: unknown) =>
        toast({ description: error instanceof Error ? error.message : failure }),
      )
      .finally(() => setBusy(null));
  };

  const backUpNow = () =>
    run(
      'now',
      async () => {
        await createBackupNow(owner);
        await refresh();
        toast({ description: 'Backup saved on the server.' });
      },
      "Couldn't back up — try again.",
    );

  const saveConfig = (patch: { intervalHours?: number; keep?: number }) =>
    run(
      'config',
      async () => {
        await updateBackupConfig(patch);
        await refresh();
      },
      "Couldn't save the backup schedule.",
    );

  const download = (name: string) =>
    run(
      name,
      async () => onDownload(await getBackupFile(name, owner), name),
      "Couldn't download that backup.",
    );

  const restore = (name: string) =>
    run(
      name,
      async () => onRestore(await getBackupFile(name, owner)),
      "Couldn't read that backup.",
    );

  const bridge = desktopBridge();
  const openFolder = () => {
    if (!status || !bridge?.openPath) return;
    bridge.openPath(status.folder).catch(() => toast({ description: "Couldn't open the folder." }));
  };

  if (unavailable) {
    return (
      <>
        <Group label="Automatic backups" />
        <Field label="Automatic backups" hint="Written by the server on a schedule" disabled>
          <span className="text-xs text-muted-foreground">Unavailable from this device</span>
        </Field>
      </>
    );
  }

  return (
    <>
      <Group label="Automatic backups" />
      <Field
        label="Last automatic backup"
        hint="The server saves your library and history on a schedule"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {!status
              ? 'Checking…'
              : status.lastBackupAt
                ? formatDate(status.lastBackupAt)
                : 'None yet'}
          </span>
          <ActionButton onClick={backUpNow} disabled={!status || busy !== null}>
            {busy === 'now' ? 'Backing up…' : 'Back up now'}
          </ActionButton>
          {bridge?.openPath && status && status.files.length > 0 && (
            <ActionButton onClick={openFolder}>Open folder</ActionButton>
          )}
        </div>
      </Field>
      <Field label="Schedule" hint="Applies to every profile on this server">
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Backup interval"
            className={selectClass}
            value={status?.config.intervalHours ?? ''}
            disabled={!status || busy !== null}
            onChange={(event) => saveConfig({ intervalHours: Number(event.target.value) })}
          >
            {/* Keeps a server value set through env visible even if it is not a preset. */}
            {status && !INTERVAL_OPTIONS.some((o) => o.value === status.config.intervalHours) && (
              <option value={status.config.intervalHours}>
                Every {status.config.intervalHours} hours
              </option>
            )}
            {INTERVAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Backups to keep"
            className={selectClass}
            value={status?.config.keep ?? ''}
            disabled={!status || busy !== null}
            onChange={(event) => saveConfig({ keep: Number(event.target.value) })}
          >
            {status && !KEEP_OPTIONS.includes(status.config.keep) && (
              <option value={status.config.keep}>Keep {status.config.keep}</option>
            )}
            {KEEP_OPTIONS.map((keep) => (
              <option key={keep} value={keep}>
                Keep {keep}
              </option>
            ))}
          </select>
        </div>
      </Field>
      {status && status.files.length > 0 && (
        <ul className="mt-3 divide-y divide-border/50 rounded-lg border border-border/60">
          {status.files.map((file) => (
            <li
              key={file.name}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
            >
              <span className="text-foreground">
                {formatDate(file.createdAt)}
                <span className="ml-2 text-muted-foreground">{formatSize(file.size)}</span>
              </span>
              <span className="flex gap-2">
                <ActionButton onClick={() => download(file.name)} disabled={busy !== null}>
                  {busy === file.name ? 'Working…' : 'Download'}
                </ActionButton>
                <ActionButton
                  onClick={() => restore(file.name)}
                  disabled={disabled || busy !== null}
                >
                  Restore…
                </ActionButton>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
