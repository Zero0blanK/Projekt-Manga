'use client';

import { useEffect } from 'react';
import { useCurrentUser } from '@/lib/session-resource';
import { checkPendingRestore, subscribeToRestore } from '@/lib/restore-job';
import { reportError } from '@/lib/report-error';

export function RestoreJobMonitor() {
  const { user, loading } = useCurrentUser();
  useEffect(() => {
    if (loading) return;
    const owner = user?.id ?? 'anonymous';
    let stopped = false;
    let reported = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const check = async () => {
      try {
        const state = await checkPendingRestore(owner, controller.signal);
        reported = false;
        if (!stopped && state === 'waiting') timer = setTimeout(check, 1500);
      } catch (error) {
        if (stopped) return;
        if (!reported)
          reportError(error, "Couldn't check restore status. Retrying in the background.");
        reported = true;
        timer = setTimeout(check, 5000);
      }
    };
    const started = () => {
      clearTimeout(timer);
      void check();
    };
    // Not on progress: this check is what saves it.
    const unsubscribe = subscribeToRestore(started, ['started']);
    void check();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      unsubscribe();
    };
  }, [user?.id, loading]);
  return null;
}
