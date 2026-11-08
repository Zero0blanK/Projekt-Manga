'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

/** After this long the screen explains why it is taking a while. */
const SLOW_AFTER_MS = 8000;

/**
 * Shown by AppShell while the desktop app's API is still starting, in place of pages that
 * would only fail. Usually never seen: the boot splash covers a normal start. It appears on
 * a slow one, typically the first start after an update.
 */
export function ServerStartingScreen({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const slow = elapsedMs >= SLOW_AFTER_MS;

  return (
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-background p-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">Starting Projekt Manga…</p>
        {slow && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            The first start after an update takes longer while Windows checks the newly installed
            files. Your library will open as soon as it&apos;s ready.
            {startedAt ? ` (${Math.round(elapsedMs / 1000)}s)` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
