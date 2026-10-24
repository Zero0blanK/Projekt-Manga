'use client';

import { X } from 'lucide-react';
import { cancelLibraryUpdate, useLibraryUpdateProgress } from '@/lib/run-library-update';

/** Circumference of the ring below, for the stroke-dash trick that draws the arc. */
const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A library update's progress, as a dial pinned to the bottom-right corner.
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
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  const percent = Math.round(fraction * 100);

  return (
    <div
      // Above the page but below dialogs and toasts, so a modal still covers it.
      className="pointer-events-none fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)]"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-border/60 bg-popover/95 p-3 shadow-xl shadow-black/30 backdrop-blur">
        <div className="relative grid h-11 w-11 shrink-0 place-items-center">
          <svg className="h-11 w-11 -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
            <circle
              cx="22"
              cy="22"
              r={RADIUS}
              fill="none"
              strokeWidth="3"
              className="stroke-muted"
            />
            <circle
              cx="22"
              cy="22"
              r={RADIUS}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              className="stroke-primary transition-[stroke-dashoffset] duration-300"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            />
          </svg>
          {/* tabular-nums so the number does not jitter the ring as it counts up. */}
          <span className="absolute text-[10px] font-semibold tabular-nums text-foreground">
            {percent}%
          </span>
        </div>

        <div className="min-w-0">
          {/* One live region for the whole thing: announcing the ring and the caption
              separately would read the same update twice. */}
          <p role="status" className="text-xs font-medium text-foreground">
            Checking {done}/{total}
            {found > 0 && (
              <span className="ml-1.5 font-normal text-primary">
                {found} new chapter{found === 1 ? '' : 's'}
              </span>
            )}
          </p>
          <p className="mt-0.5 max-w-[14rem] truncate text-[11px] text-muted-foreground">{title}</p>
        </div>

        <button
          type="button"
          onClick={cancelLibraryUpdate}
          aria-label="Stop checking for updates"
          title="Stop"
          className="grid h-7 w-7 pointer-coarse:size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
