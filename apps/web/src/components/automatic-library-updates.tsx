'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { useLibraryState, useMangaLibrary } from '@/lib/library-store';
import { entriesInGlobalUpdate } from '@/lib/library-update';
import {
  cancelLibraryUpdate,
  isLibraryUpdateRunning,
  runLibraryUpdate,
} from '@/lib/run-library-update';
import { actions, useAppState, useNumberSetting, useSetting } from '@/lib/app-store';
import { showWindowNotification } from '@/lib/window-notification';
import { isQuietHours } from '@/lib/notification-preferences';
import { useCurrentUser } from '@/lib/session-resource';

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
  const skipCompleted = useSetting('skipCompletedOnUpdate', false) as boolean;
  const refreshCovers = useSetting('refreshCoversOnUpdate', false) as boolean;
  const notifyNewChapters = useSetting('notifyNewChapter', true) as boolean;
  const notifyErrors = useSetting('notifyUpdateErrors', true) as boolean;
  const notifyOutsideApp = useSetting('notifyDesktop', false) as boolean;
  const quietHoursEnabled = useSetting('quietHoursEnabled', false) as boolean;
  const quietHoursStart = useSetting('quietHoursStart', '22:00') as string;
  const quietHoursEnd = useSetting('quietHoursEnd', '07:00') as string;
  const settings = useAppState((state) => state.settings);
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
    const entries = entriesInGlobalUpdate(library, shelf, skipCompleted);
    if (entries.length === 0) return;

    const globalIntervalHours = Number.isFinite(intervalHours)
      ? Math.max(1, Math.min(intervalHours, 168))
      : 12;
    const intervalMs = globalIntervalHours * HOUR_MS;
    const sourceIntervals = new Map<string, number>();
    for (const entry of entries) {
      const sourceOverride = settings[`automaticLibraryUpdateSourceIntervalHours:${entry.source}`];
      const minimumHours =
        typeof sourceOverride === 'number' && Number.isFinite(sourceOverride)
          ? Math.max(1, Math.min(sourceOverride, 168))
          : 1;
      sourceIntervals.set(entry.source, Math.max(globalIntervalHours, minimumHours) * HOUR_MS);
    }
    const sourceDueAt = (source: string) => {
      const storedLastAttempt =
        settings[`automaticLibraryUpdateLastCheckedAt:${accountId}:${source}`];
      const lastAttempt =
        typeof storedLastAttempt === 'number' &&
        Number.isFinite(storedLastAttempt) &&
        storedLastAttempt >= 0
          ? storedLastAttempt
          : 0;
      const sourceInterval = sourceIntervals.get(source) ?? intervalMs;
      return Math.max(lastAttempt + sourceInterval, retryAt);
    };
    const nextDueAt = Math.min(...[...sourceIntervals.keys()].map(sourceDueAt));
    const dueIn = Math.max(0, nextDueAt - Date.now());
    const timer = window.setTimeout(() => {
      if (currentlySuspended.current) return;
      if (running.current || isLibraryUpdateRunning()) {
        setRetryAt(Date.now() + BUSY_CHECK_RETRY_MS);
        return;
      }
      const dueSources = new Set(
        [...sourceIntervals.keys()].filter((source) => sourceDueAt(source) <= Date.now()),
      );
      const dueEntries = entries.filter((entry) => dueSources.has(entry.source));
      if (dueEntries.length === 0) return;

      running.current = true;
      void runLibraryUpdate(dueEntries, {
        refreshCovers,
        onSourceStart: (source) => {
          actions.setSetting(
            `automaticLibraryUpdateLastCheckedAt:${accountId}:${source}`,
            Date.now(),
          );
        },
      })
        .then(({ foundBySource, failed, failedBySource, cancelled }) => {
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
          const notifiedNewChapters = Object.entries(foundBySource)
            .filter(([source]) => notifyForSource(source))
            .reduce((total, [, count]) => total + count, 0);
          if (notifiedNewChapters > 0 && notifyNewChapters) {
            const summary = `${notifiedNewChapters} new chapter${notifiedNewChapters === 1 ? '' : 's'} found automatically.`;
            toast({ title: 'New chapters available', description: summary });
            const quiet =
              quietHoursEnabled && isQuietHours(new Date(), quietHoursStart, quietHoursEnd);
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
    skipCompleted,
    refreshCovers,
    notifyNewChapters,
    notifyErrors,
    notifyOutsideApp,
    quietHoursEnabled,
    quietHoursStart,
    quietHoursEnd,
    settings,
    refresh,
  ]);

  return null;
}
