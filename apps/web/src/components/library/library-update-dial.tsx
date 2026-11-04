'use client';

import { ProgressDial } from '@/components/progress-dial';
import { cancelLibraryUpdate, useLibraryUpdateProgress } from '@/lib/run-library-update';

/**
 * A library update's progress, as a dial in the bottom-right corner.
 *
 * It floats in the corner where toasts appear, so it never displaces page layout and keeps
 * reporting as the reader moves to other screens during a long check.
 *
 * Mounted once in the app shell rather than by the button, because the update itself is
 * app-wide state (`run-library-update.ts` holds it in a module, and automatic updates start
 * with no button involved at all).
 */
export function LibraryUpdateDial() {
  const progress = useLibraryUpdateProgress();
  if (!progress) return null;

  const { done, total, found, title } = progress;
  return (
    <ProgressDial
      id="library-update"
      name="library update"
      fraction={total > 0 ? Math.min(1, done / total) : 0}
      status={
        <>
          Checking {done}/{total}
          {found > 0 && (
            <span className="ml-1.5 font-normal text-primary">
              {found} new chapter{found === 1 ? '' : 's'}
            </span>
          )}
        </>
      }
      detail={title}
      onStop={cancelLibraryUpdate}
      stopLabel="Stop checking for updates"
    />
  );
}
