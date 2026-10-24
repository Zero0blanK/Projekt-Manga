'use client';

import { useEffect, useState } from 'react';
import {
  getDownloadStats,
  setDownloadStorageLimit,
  getDownloadDirectory,
  hasLocalDataBridge,
  type DownloadStats,
} from '@projekt-manga/api-client';
import { Panel, Field, Group, Toggle, Select } from '@/components/settings/field-controls';
import { DownloadFolderField } from '@/components/settings/download-folder-field';
import { OpenFolderButton } from '@/components/downloads/open-folder-button';
import { useCurrentUser } from '@/lib/session-resource';
import { isAborted, reportError } from '@/lib/report-error';
import { useRestorePending } from '@/lib/restore-job';
import { runDesktopSync, useDesktopSyncState } from '@/lib/desktop-sync';
import { useSetting } from '@/lib/app-store';
import { Button } from '@/components/ui/button';

type DesktopInitState = {
  seedStatus: 'idle' | 'running' | 'done' | 'failed';
  hadLocalData: boolean;
  seededManga: number;
};

const readDesktopInitState = async (): Promise<DesktopInitState | null> => {
  const init = (window as Window & { desktop?: { init?: { getState: () => Promise<unknown> } } })
    .desktop?.init;
  if (!init) return null;
  const response = await init.getState();
  if (!response || typeof response !== 'object' || !('data' in response)) return null;
  const data = response.data;
  if (
    !data ||
    typeof data !== 'object' ||
    !('seedStatus' in data) ||
    !['idle', 'running', 'done', 'failed'].includes(String(data.seedStatus)) ||
    !('hadLocalData' in data) ||
    typeof data.hadLocalData !== 'boolean' ||
    !('seededManga' in data) ||
    typeof data.seededManga !== 'number'
  ) {
    return null;
  }
  return data as DesktopInitState;
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function SyncPanel() {
  const [stats, setStats] = useState<DownloadStats | null>(null);
  const [limitGb, setLimitGb] = useState('');
  const [savingLimit, setSavingLimit] = useState(false);
  const [limitNotice, setLimitNotice] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [desktopInit, setDesktopInit] = useState<DesktopInitState | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const { user } = useCurrentUser();
  const isDesktop = hasLocalDataBridge();
  const syncState = useDesktopSyncState();
  const restorePending = useRestorePending();
  const desktopSyncEnabled = useSetting('desktopSyncEnabled', true) === true;

  useEffect(() => {
    const controller = new AbortController();
    getDownloadStats(controller.signal)
      .then((value) => {
        setStats(value);
        setLimitGb(String(value.storageLimit / 1024 ** 3));
      })
      .catch((error) => {
        if (!isAborted(error)) reportError(error, 'Could not load download storage usage.');
      });
    getDownloadDirectory(controller.signal)
      .then(({ path }) => setFolder(path))
      .catch((error) => {
        if (!isAborted(error)) reportError(error, 'Could not load the download folder.');
      });
    return () => controller.abort();
  }, []);

  const limitBytes = Math.round(Number(limitGb) * 1024 ** 3);
  const validLimit =
    limitGb.trim().length > 0 && Number.isSafeInteger(limitBytes) && limitBytes > 0;
  const saveLimit = async () => {
    if (!validLimit || savingLimit) return;
    setSavingLimit(true);
    setLimitNotice('');
    try {
      const { bytes } = await setDownloadStorageLimit(limitBytes);
      setStats((current) => (current ? { ...current, storageLimit: bytes } : current));
      setLimitGb(String(bytes / 1024 ** 3));
      setLimitNotice('Storage limit saved.');
    } catch (error) {
      reportError(error, 'Could not save the storage limit.');
      setLimitNotice('Could not save the limit. Try again.');
    } finally {
      setSavingLimit(false);
    }
  };

  useEffect(() => {
    if (!isDesktop) return;
    const updateConnectivity = () => setOnline(navigator.onLine);
    updateConnectivity();
    window.addEventListener('online', updateConnectivity);
    window.addEventListener('offline', updateConnectivity);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollInit = async () => {
      try {
        const state = await readDesktopInitState();
        if (cancelled) return;
        setDesktopInit(state);
        if (state && (state.seedStatus === 'idle' || state.seedStatus === 'running')) {
          timer = setTimeout(() => void pollInit(), 1_000);
        }
      } catch {
        if (!cancelled) setDesktopInit(null);
      }
    };
    void pollInit();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', updateConnectivity);
      window.removeEventListener('offline', updateConnectivity);
    };
  }, [isDesktop]);

  return (
    <div className="space-y-6">
      <Panel title="Storage" subtitle="Where downloaded chapters live">
        <DownloadFolderField />
        <Field label="Open folder" hint="Reveal the download folder on this machine">
          <OpenFolderButton path={folder} label="Open download folder" withText />
        </Field>
        <Field label="On disk" hint="Across every completed download">
          <span className="text-xs tabular-nums text-muted-foreground">
            {stats
              ? `${stats.completed} ${stats.completed === 1 ? 'chapter' : 'chapters'} · ${formatBytes(stats.totalSize)}`
              : '—'}
          </span>
        </Field>
        <Field
          label="Storage limit"
          hint="Shared by this device/server. Stops new download writes when reached; lowering it never deletes existing downloads."
        >
          <div className="space-y-2">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveLimit();
              }}
              className="flex items-center gap-2"
            >
              <label className="flex items-center gap-2">
                <span className="sr-only">Storage limit in GB</span>
                <input
                  type="number"
                  min={1 / 1024 ** 3}
                  step="any"
                  value={limitGb}
                  disabled={!stats || savingLimit}
                  onChange={(event) => {
                    setLimitGb(event.target.value);
                    setLimitNotice('');
                  }}
                  className="h-9 w-24 rounded-lg border border-border bg-background px-3 text-sm"
                />
                <span className="text-xs text-muted-foreground">GB</span>
              </label>
              <Button
                type="submit"
                size="sm"
                disabled={!stats || !validLimit || savingLimit || limitBytes === stats.storageLimit}
              >
                {savingLimit ? 'Saving…' : 'Save'}
              </Button>
            </form>
            <p className="text-xs tabular-nums text-muted-foreground">
              {stats
                ? `${formatBytes(stats.totalSize)} of ${formatBytes(stats.storageLimit)} used`
                : 'Loading storage limit…'}
            </p>
            {stats && validLimit && limitBytes < stats.totalSize && (
              <p className="text-xs text-muted-foreground">
                Current usage exceeds this limit. New download writes will stop until space is freed
                or the limit is raised.
              </p>
            )}
            {limitNotice && (
              <p role="status" className="text-xs text-muted-foreground">
                {limitNotice}
              </p>
            )}
          </div>
        </Field>
      </Panel>

      <Panel title="Library updates" subtitle="What Update Library checks">
        <Field
          label="Skip finished titles"
          hint="Leave out completed and cancelled series — nothing new is coming for them"
        >
          <Toggle settingKey="skipCompletedOnUpdate" />
        </Field>
        <Field
          label="Check a title when you reload its page"
          hint="Reloading a series' page fetches its new chapters. Opening it normally doesn't — use the refresh button on the page for that."
        >
          <Toggle settingKey="checkChaptersOnReload" defaultOn />
        </Field>
        <Field
          label="Refresh covers during update"
          hint="Re-fetch artwork when a source changes it"
        >
          <Toggle settingKey="refreshCoversOnUpdate" />
        </Field>
      </Panel>

      <Panel title="Cross-device sync" subtitle="Account sync at work">
        {isDesktop && (
          <Field label="Local library" hint="The desktop keeps a local copy for offline reading">
            <span role="status" className="text-xs text-muted-foreground">
              {!desktopInit
                ? 'Checking local library…'
                : desktopInit.hadLocalData || desktopInit.seedStatus === 'done'
                  ? `Available offline${desktopInit.seedStatus === 'running' ? ' · refreshing in background' : ''}`
                  : desktopInit.seedStatus === 'failed'
                    ? 'Local setup could not finish; the library may be empty'
                    : 'Preparing local library…'}
            </span>
          </Field>
        )}
        {!user ? (
          <Field
            label="Cross-device sync"
            hint="Create an account in the Profile tab to sync your library, progress, and history across devices"
            disabled
          >
            <span className="text-xs text-muted-foreground">Local only</span>
          </Field>
        ) : isDesktop ? (
          <>
            <Field
              label="Sync this device"
              hint="Stop new account sync runs on this desktop. A sync already in progress may finish; local reading and downloads continue to work."
            >
              <Toggle settingKey="desktopSyncEnabled" defaultOn label="Sync this device" />
            </Field>
            <Field
              label="Automatic sync"
              hint="Runs while enabled, active, and online, at the chosen interval"
            >
              <Select
                settingKey="desktopSyncInterval"
                options={['Off', '5 minutes', '15 minutes', '30 minutes', '60 minutes']}
                defaultValue="15 minutes"
              />
            </Field>
            <Field
              label="Sync with server"
              hint={
                online === false
                  ? 'Offline. Local reading and downloads remain available; sync can be retried when online.'
                  : desktopSyncEnabled
                    ? 'Pushes local changes, then pulls the merged result'
                    : 'Sync is paused for this device; local reading and downloads remain available'
              }
            >
              <div className="flex items-center gap-3">
                {syncState.lastSuccess && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    Last synced: {new Date(syncState.lastSuccess).toLocaleString()}
                  </span>
                )}
                {syncState.error && (
                  <span role="status" className="text-xs text-destructive">
                    {online === false
                      ? `Offline; sync will need a retry when online. ${syncState.error}`
                      : `Server sync failed: ${syncState.error}`}
                  </span>
                )}
                <button
                  onClick={() => void runDesktopSync()}
                  disabled={
                    syncState.running || restorePending || online === false || !desktopSyncEnabled
                  }
                  className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
                >
                  {syncState.running
                    ? 'Syncing…'
                    : restorePending
                      ? 'Restoring…'
                      : !desktopSyncEnabled
                        ? 'Sync paused'
                        : online === false
                          ? 'Offline'
                          : syncState.error
                            ? 'Retry sync'
                            : 'Sync now'}
                </button>
              </div>
            </Field>
          </>
        ) : (
          <Field
            label="Cross-device sync"
            hint="Signed in — your library, progress, and history are read live from your account on every device, nothing to sync in a browser"
          >
            <span className="text-xs text-muted-foreground">Always up to date</span>
          </Field>
        )}
      </Panel>

      <Panel title="Download automation" subtitle="Background download behavior">
        <Group label="Downloads" />
        {/* TODO: needs the scheduler described in the Notifications panel — nothing runs
            after a library update to queue new chapters. */}
        <Field
          label="Auto-download new chapters"
          hint="No scheduler runs after an update to queue them"
          disabled
        >
          <span className="text-xs text-muted-foreground">Coming soon.</span>
        </Field>
      </Panel>
    </div>
  );
}
