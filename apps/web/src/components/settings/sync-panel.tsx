'use client';

import { useEffect, useState } from 'react';
import {
  getDownloadStats,
  setDownloadStorageLimit,
  getDownloadDirectory,
  hasLocalDataBridge,
  type DownloadStats,
} from '@projekt-manga/api-client';
import {
  Panel,
  Field,
  Group,
  Toggle,
  Select,
  OptionSelect,
  NumberSelect,
} from '@/components/settings/field-controls';
import {
  AUTO_DOWNLOAD_NEW,
  DELETE_AFTER_READ,
  DOWNLOAD_AHEAD,
  categoryScope,
} from '@/lib/auto-downloads';
import { DownloadFolderField } from '@/components/settings/download-folder-field';
import { OpenFolderButton } from '@/components/downloads/open-folder-button';
import { useCurrentUser } from '@/lib/session-resource';
import { isAborted, reportError } from '@/lib/report-error';
import { useRestorePending } from '@/lib/restore-job';
import { runDesktopSync, useDesktopSyncState } from '@/lib/desktop-sync';
import { actions, useAppState, useSetting } from '@/lib/app-store';
import { UPDATE_SETTING, parseCategoryList } from '@/lib/library-update';
import { CATEGORY_UPDATE_SETTING, parseCategoryIntervals } from '@/lib/update-schedule';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown } from 'lucide-react';

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
  // Library categories, for "Download new chapters" scoped to one of them.
  const categoryNames = Object.keys(useAppState((s) => s.categoryMembers)).sort();
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
        <Field label="Storage limit" hint="New downloads stop at this size; nothing is deleted">
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
        <Field label="Skip finished titles" hint="Skip completed and cancelled series">
          <Toggle settingKey={UPDATE_SETTING.skipCompleted} />
        </Field>
        <Field label="Skip titles with unread chapters" hint="Wait until you've caught up">
          <Toggle settingKey={UPDATE_SETTING.skipUnread} />
        </Field>
        <Field label="Skip titles not started" hint="Skip titles you haven't read yet">
          <Toggle settingKey={UPDATE_SETTING.skipNotStarted} />
        </Field>
        <Field
          label="Smart update"
          hint="Scheduled updates skip titles not expected to release soon"
        >
          <Toggle settingKey={UPDATE_SETTING.smartUpdate} />
        </Field>
        <Field label="Only these categories" hint="None selected checks every category">
          <CategoryListSetting settingKey={UPDATE_SETTING.includeCategories} />
        </Field>
        <Field label="Never these categories" hint="Wins over the list above">
          <CategoryListSetting settingKey={UPDATE_SETTING.excludeCategories} />
        </Field>
        <Field
          label="Check a title when you reload its page"
          hint="Reloading a series page fetches new chapters"
        >
          <Toggle settingKey="checkChaptersOnReload" defaultOn />
        </Field>
        <Field
          label="Refresh covers during update"
          hint="Re-fetch artwork when a source changes it"
        >
          <Toggle settingKey="refreshCoversOnUpdate" />
        </Field>
        <Group label="Per category" />
        <Field
          label="Category check intervals"
          hint="Scheduled checks for a category's titles. In several categories, the shortest wins; a source's minimum still applies"
        >
          <CategoryIntervalSetting />
        </Field>
        <Field label="Mute new-chapter alerts" hint="New chapters in these categories stay silent">
          <CategoryListSetting settingKey={CATEGORY_UPDATE_SETTING.mutedCategories} />
        </Field>
      </Panel>

      <Panel title="Cross-device sync" subtitle="Account sync at work">
        {isDesktop && (
          <Field label="Local library" hint="Kept on this device for offline reading">
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
            hint="Create an account in Profile to sync across devices"
            disabled
          >
            <span className="text-xs text-muted-foreground">Local only</span>
          </Field>
        ) : isDesktop ? (
          <>
            <Field label="Sync this device" hint="Pause account sync on this desktop">
              <Toggle settingKey="desktopSyncEnabled" defaultOn label="Sync this device" />
            </Field>
            <Field label="Automatic sync" hint="Syncs at this interval while online">
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
                  ? 'Offline; reading and downloads still work'
                  : desktopSyncEnabled
                    ? 'Sends local changes, then fetches the result'
                    : 'Paused on this device'
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
          <Field label="Cross-device sync" hint="Your account is already live on every device">
            <span className="text-xs text-muted-foreground">Always up to date</span>
          </Field>
        )}
      </Panel>

      <Panel title="Download automation" subtitle="Downloads that happen on their own">
        <Group label="Downloads" />
        <Field
          label="Download new chapters"
          hint="Chapters a library update finds, for the titles chosen here"
        >
          <OptionSelect
            settingKey={AUTO_DOWNLOAD_NEW}
            defaultValue="off"
            options={[
              { value: 'off', label: 'Off' },
              { value: 'all', label: 'All titles' },
              ...categoryNames.map((name) => ({ value: categoryScope(name), label: name })),
            ]}
          />
        </Field>
        <Field label="Download ahead" hint="Chapters after the one you're reading">
          <NumberSelect
            settingKey={DOWNLOAD_AHEAD}
            defaultValue={0}
            options={[0, 1, 2, 3, 5]}
            format={(value) => (value === 0 ? 'Off' : `${value} chapter${value === 1 ? '' : 's'}`)}
          />
        </Field>
        <Field label="Delete after reading" hint="Bookmarked chapters are always kept">
          <OptionSelect
            settingKey={DELETE_AFTER_READ}
            defaultValue="off"
            options={[
              { value: 'off', label: 'Off' },
              { value: 'immediately', label: 'Right after reading' },
              { value: 'afterNext', label: 'After the next chapter' },
            ]}
          />
        </Field>
      </Panel>
    </div>
  );
}

/** Picks library categories for an update rule, stored as a JSON list. */
function CategoryListSetting({ settingKey }: { settingKey: string }) {
  const categories = useAppState((state) => state.customCategories);
  const selected = parseCategoryList(useSetting(settingKey, ''));
  if (categories.length === 0)
    return <span className="text-xs text-muted-foreground">No categories yet</span>;
  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((item) => item !== name)
      : [...selected, name];
    actions.setSetting(settingKey, next.length > 0 ? JSON.stringify(next) : '');
  };
  return (
    <div className="flex max-w-sm flex-wrap justify-end gap-1.5">
      {categories.map((name) => {
        const on = selected.includes(name);
        return (
          <button
            key={name}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(name)}
            className={`rounded-full border px-2.5 py-1 text-xs transition ${
              on
                ? 'border-primary/60 bg-primary/15 text-primary'
                : 'border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

const CATEGORY_INTERVAL_OPTIONS = [1, 3, 6, 12, 24, 48, 72, 168];

/** Per-category scheduled-check intervals, stored as a JSON `{ category: hours }` map. */
function CategoryIntervalSetting() {
  const categories = useAppState((state) => state.customCategories);
  const intervals = parseCategoryIntervals(useSetting(CATEGORY_UPDATE_SETTING.intervals, ''));
  if (categories.length === 0)
    return <span className="text-xs text-muted-foreground">No categories yet</span>;
  const choose = (name: string, hours: number | null) => {
    const next = { ...intervals };
    if (hours === null) delete next[name];
    else next[name] = hours;
    actions.setSetting(
      CATEGORY_UPDATE_SETTING.intervals,
      Object.keys(next).length > 0 ? JSON.stringify(next) : '',
    );
  };
  return (
    <div className="space-y-1.5">
      {categories.map((name) => {
        const hours = intervals[name];
        return (
          <div key={name} className="flex items-center justify-end gap-3">
            <span className="truncate text-xs text-muted-foreground">{name}</span>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                aria-label={`${name} check interval`}
                className="flex h-8 min-w-32 items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary/60"
              >
                {hours === undefined ? 'Global interval' : `${hours} hours`}
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-32">
                <DropdownMenuItem
                  onSelect={() => choose(name, null)}
                  className={`text-xs ${hours === undefined ? 'text-primary' : ''}`}
                >
                  Global interval
                </DropdownMenuItem>
                {CATEGORY_INTERVAL_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option}
                    onSelect={() => choose(name, option)}
                    className={`text-xs ${option === hours ? 'text-primary' : ''}`}
                  >
                    {option} hours
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}
