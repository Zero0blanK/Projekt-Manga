'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { useLibraryState, useMangaLibrary } from '@/lib/library-store';
import { getReleaseEstimates, sendChapterAlert } from '@projekt-manga/api-client';
import {
  UPDATE_SETTING,
  dueForSmartUpdate,
  entriesInGlobalUpdate,
  useGlobalUpdateRules,
} from '@/lib/library-update';
import {
  cancelLibraryUpdate,
  isLibraryUpdateRunning,
  runLibraryUpdate,
} from '@/lib/run-library-update';
import { actions, useAppState, useNumberSetting, useSetting } from '@/lib/app-store';
import { showWindowNotification } from '@/lib/window-notification';
import { isQuietHours } from '@/lib/notification-preferences';
import { useCurrentUser } from '@/lib/session-resource';
import {
  CATEGORY_UPDATE_SETTING,
  clampIntervalHours,
  notifiableNewChapters,
  chapterAlertTitles,
  parseCategoryIntervals,
  parseMutedCategories,
  updateBuckets,
} from '@/lib/update-schedule';

const HOUR_MS = 60 * 60 * 1000;
const FAILED_CHECK_RETRY_MS = HOUR_MS;
const BUSY_CHECK_RETRY_MS = 5 * 60_000;

/**
 * Per-device automatic updates. Browser timers cannot survive a closed app, so the
 * settings panel says exactly that; while this renderer is open the same serialized
 * updater used by the manual button runs at the reader's chosen cadence.
 */
export function AutomaticLibraryUpdates({ suspended = false }: { suspended?: boolean }) {
  const { manga: library, loading, refresh } = useMangaLibrary();
  const { shelf } = useLibraryState();
  const enabled = useSetting('automaticLibraryUpdates', true) as boolean;
  const intervalHours = useNumberSetting('automaticLibraryUpdateIntervalHours', 12);
  const updateRules = useGlobalUpdateRules();
  const smartUpdate = useSetting(UPDATE_SETTING.smartUpdate, false) as boolean;
  const refreshCovers = useSetting('refreshCoversOnUpdate', false) as boolean;
  const notifyNewChapters = useSetting('notifyNewChapter', true) as boolean;
  const notifyErrors = useSetting('notifyUpdateErrors', true) as boolean;
  const notifyOutsideApp = useSetting('notifyDesktop', false) as boolean;
  const quietHoursEnabled = useSetting('quietHoursEnabled', false) as boolean;
  const quietHoursStart = useSetting('quietHoursStart', '22:00') as string;
  const quietHoursEnd = useSetting('quietHoursEnd', '07:00') as string;
  const categoryIntervalsSetting = useSetting(CATEGORY_UPDATE_SETTING.intervals, '');
  const mutedCategoriesSetting = useSetting(CATEGORY_UPDATE_SETTING.mutedCategories, '');
  const settings = useAppState((state) => state.settings);
  const categoryMembers = useAppState((state) => state.categoryMembers);
  const { user, loading: sessionLoading } = useCurrentUser();
  const accountId = user?.id ?? 'anonymous';
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;
  const running = useRef(false);
  const currentlySuspended = useRef(suspended);
  currentlySuspended.current = suspended;
  const retryAccount = useRef(accountId);
  const [retryAt, setRetryAt] = useState(0);

  useEffect(() => {
    if (retryAccount.current !== accountId) {
      retryAccount.current = accountId;
      setRetryAt(0);
    }
    return () => cancelLibraryUpdate();
  }, [accountId]);

  useEffect(() => {
    if (suspended) cancelLibraryUpdate();
  }, [suspended]);

  useEffect(() => {
    if (suspended || !enabled || loading || sessionLoading) return;
    const entries = entriesInGlobalUpdate(library, shelf, updateRules);
    if (entries.length === 0) return;

    const globalIntervalHours = clampIntervalHours(intervalHours) ?? 12;
    // One bucket per source and interval: category intervals (shortest wins) can split a
    // source's titles across cadences, each with its own last-checked time.
    const buckets = updateBuckets(entries, {
      globalHours: globalIntervalHours,
      sourceMinimumHours: (source) =>
        clampIntervalHours(settings[`automaticLibraryUpdateSourceIntervalHours:${source}`]),
      categoryIntervals: parseCategoryIntervals(categoryIntervalsSetting),
      categoryMembers,
    });
    const lastCheckedKey = (bucketKey: string) =>
      `automaticLibraryUpdateLastCheckedAt:${accountId}:${bucketKey}`;
    const bucketDueAt = (bucketKey: string) => {
      const bucket = buckets.get(bucketKey);
      // A bucket a category interval just created starts from its source's last check, so
      // changing an interval doesn't fire an immediate extra update.
      const storedLastAttempt =
        settings[lastCheckedKey(bucketKey)] ??
        (bucket ? settings[lastCheckedKey(bucket.source)] : undefined);
      const lastAttempt =
        typeof storedLastAttempt === 'number' &&
        Number.isFinite(storedLastAttempt) &&
        storedLastAttempt >= 0
          ? storedLastAttempt
          : 0;
      const intervalMs = (bucket?.intervalHours ?? globalIntervalHours) * HOUR_MS;
      return Math.max(lastAttempt + intervalMs, retryAt);
    };
    const nextDueAt = Math.min(...[...buckets.keys()].map(bucketDueAt));
    const dueIn = Math.max(0, nextDueAt - Date.now());
    const timer = window.setTimeout(() => {
      if (currentlySuspended.current) return;
      if (running.current || isLibraryUpdateRunning()) {
        setRetryAt(Date.now() + BUSY_CHECK_RETRY_MS);
        return;
      }
      const dueBuckets = [...buckets.keys()].filter((key) => bucketDueAt(key) <= Date.now());
      const dueIds = new Set(
        dueBuckets.flatMap((key) => buckets.get(key)!.entries.map((e) => e.id)),
      );
      const sourceDue = entries.filter((entry) => dueIds.has(entry.id));
      if (sourceDue.length === 0) return;
      const markChecked = (source: string) => {
        for (const key of dueBuckets) {
          if (buckets.get(key)?.source === source)
            actions.setSetting(lastCheckedKey(key), Date.now());
        }
      };

      running.current = true;
      // Smart update narrows a scheduled run to titles expected to have a release soon.
      // A source left with nothing to check still counts as checked, so the timer waits a
      // full interval instead of firing again straight away.
      const smartFiltered = smartUpdate
        ? getReleaseEstimates()
            .then((list) => new Map(list.map((e) => [e.manga_id, e.next_expected_at])))
            .catch(() => null)
            .then((estimates) => dueForSmartUpdate(sourceDue, estimates))
        : Promise.resolve(sourceDue);
      void smartFiltered
        .then((dueEntries) => {
          const checking = new Set(dueEntries.map((entry) => entry.source));
          for (const source of new Set(sourceDue.map((entry) => entry.source))) {
            if (!checking.has(source)) markChecked(source);
          }
          if (dueEntries.length === 0 || currentlySuspended.current) return null;
          return runLibraryUpdate(dueEntries, { refreshCovers, onSourceStart: markChecked });
        })
        .then((result) => {
          if (!result) return;
          const { foundByManga, failed, failedBySource, cancelled } = result;
          if (cancelled || currentlySuspended.current || currentAccount.current !== accountId)
            return;
          const checkedAt = Date.now();
          if (failed.length > 0) setRetryAt(Date.now() + FAILED_CHECK_RETRY_MS);
          else {
            setRetryAt(0);
          }
          actions.setSetting('automaticLibraryUpdateLastCheckedAt', checkedAt);
          void refresh();
          const notifyForSource = (source: string) => settings[`notifySource:${source}`] !== false;
          const sourceById = new Map(entries.map((entry) => [entry.id, entry.source]));
          const notifiedNewChapters = notifiableNewChapters(foundByManga, {
            sourceOf: (mangaId) => sourceById.get(mangaId),
            sourceNotifies: notifyForSource,
            mutedCategories: parseMutedCategories(mutedCategoriesSetting),
            categoryMembers,
          });
          if (notifiedNewChapters > 0 && notifyNewChapters) {
            const summary = `${notifiedNewChapters} new chapter${notifiedNewChapters === 1 ? '' : 's'} found automatically.`;
            toast({ title: 'New chapters available', description: summary });
            const quiet =
              quietHoursEnabled && isQuietHours(new Date(), quietHoursStart, quietHoursEnd);
            // Settings › Notifications › Outside the app: the same titles, to the user's
            // ntfy, Discord, Telegram or webhook channels. The server sends to none when
            // there are none set up.
            if (!quiet) {
              const titleById = new Map(entries.map((entry) => [entry.id, entry.title]));
              const titles = chapterAlertTitles(
                foundByManga,
                (mangaId) => result.foundTitles?.[mangaId] ?? titleById.get(mangaId),
                {
                  sourceOf: (mangaId) => sourceById.get(mangaId),
                  sourceNotifies: notifyForSource,
                  mutedCategories: parseMutedCategories(mutedCategoriesSetting),
                  categoryMembers,
                },
              );
              if (titles.length) void sendChapterAlert({ titles }).catch(() => undefined);
            }
            if (notifyOutsideApp && !quiet) {
              showWindowNotification({
                title: 'New chapters available',
                body: summary,
                tag: 'library-update',
                destination: '/notifications',
              });
            }
          }
          const notifiedFailures = Object.entries(failedBySource)
            .filter(([source]) => notifyForSource(source))
            .reduce((total, [, count]) => total + count, 0);
          if (notifiedFailures > 0 && notifyErrors) {
            const visibleTitles = new Set(
              entries.filter((entry) => notifyForSource(entry.source)).map((entry) => entry.title),
            );
            toast({
              variant: 'destructive',
              title: `${notifiedFailures} title${notifiedFailures === 1 ? '' : 's'} couldn't be checked`,
              description: failed
                .filter((title) => visibleTitles.has(title))
                .slice(0, 3)
                .join(', '),
            });
          }
        })
        .finally(() => {
          running.current = false;
        });
    }, dueIn);
    return () => window.clearTimeout(timer);
  }, [
    suspended,
    enabled,
    intervalHours,
    retryAt,
    accountId,
    sessionLoading,
    library,
    loading,
    shelf,
    updateRules,
    smartUpdate,
    refreshCovers,
    notifyNewChapters,
    notifyErrors,
    notifyOutsideApp,
    quietHoursEnabled,
    quietHoursStart,
    quietHoursEnd,
    settings,
    categoryIntervalsSetting,
    mutedCategoriesSetting,
    categoryMembers,
    refresh,
  ]);

  return null;
}
