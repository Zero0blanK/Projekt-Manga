import { useSyncExternalStore } from 'react';

/**
 * A desktop update under way after "Update now": the update prompt closes and the download
 * goes on in the background, shown by the update dial in the corner. Once it is downloaded
 * the dial becomes "Restart to update", as in VS Code: nothing restarts by itself, and an
 * update left for later installs when the app next quits. The prompt, which follows the
 * updater, writes it here; the dial reads it.
 */
export interface AppUpdateProgress {
  version: string;
  /** 0–100, or null before the download reports any. */
  percent: number | null;
  /** Downloaded and waiting for a restart. */
  ready: boolean;
}

let progress: AppUpdateProgress | null = null;
const listeners = new Set<() => void>();

export function setAppUpdateProgress(next: AppUpdateProgress | null): void {
  if (
    progress === next ||
    (progress &&
      next &&
      progress.version === next.version &&
      progress.percent === next.percent &&
      progress.ready === next.ready)
  )
    return;
  progress = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppUpdateProgress(): AppUpdateProgress | null {
  return useSyncExternalStore(
    subscribe,
    () => progress,
    () => null,
  );
}
