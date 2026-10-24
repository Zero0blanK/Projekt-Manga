'use client';

import { useEffect, useRef } from 'react';
import { hasLocalDataBridge } from '@projekt-manga/api-client';
import { useCurrentUser } from '@/lib/session-resource';
import { useSetting } from '@/lib/app-store';
import { runDesktopSync, setDesktopSyncAccount, useDesktopSyncState } from '@/lib/desktop-sync';

const INTERVALS: Record<string, number> = {
  '5 minutes': 5,
  '15 minutes': 15,
  '30 minutes': 30,
  '60 minutes': 60,
};

export function AutomaticDesktopSync({ ready }: { ready: boolean }) {
  const { user } = useCurrentUser();
  const userId = user?.id ?? null;
  const interval = useSetting('desktopSyncInterval', '15 minutes') as string;
  const syncEnabled = useSetting('desktopSyncEnabled', true) === true;
  const { lastSuccess, lastAttempt, retryAfter, running } = useDesktopSyncState();
  const lastStartedAt = useRef(0);

  useEffect(() => {
    lastStartedAt.current = 0;
    setDesktopSyncAccount(userId);
  }, [userId]);

  useEffect(() => {
    if (!ready || !hasLocalDataBridge() || !userId || !syncEnabled || !INTERVALS[interval]) return;
    const dueMs = INTERVALS[interval] * 60_000;
    const maybeSync = () => {
      if (
        navigator.onLine &&
        document.visibilityState === 'visible' &&
        !running &&
        (!lastSuccess || Date.now() - lastSuccess >= dueMs) &&
        (!retryAfter || Date.now() >= retryAfter) &&
        Date.now() - Math.max(lastAttempt ?? 0, lastStartedAt.current) >= 60_000
      ) {
        lastStartedAt.current = Date.now();
        void runDesktopSync();
      }
    };
    maybeSync();
    const timer = window.setInterval(maybeSync, Math.min(dueMs, 60_000));
    const retryTimer = retryAfter
      ? window.setTimeout(maybeSync, Math.max(0, retryAfter - Date.now()))
      : null;
    window.addEventListener('online', maybeSync);
    window.addEventListener('focus', maybeSync);
    document.addEventListener('visibilitychange', maybeSync);
    return () => {
      window.clearInterval(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.removeEventListener('online', maybeSync);
      window.removeEventListener('focus', maybeSync);
      document.removeEventListener('visibilitychange', maybeSync);
    };
  }, [ready, userId, interval, syncEnabled, lastSuccess, lastAttempt, retryAfter, running]);
  return null;
}
