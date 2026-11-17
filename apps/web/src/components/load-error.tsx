'use client';

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { describeLoadError } from '@/lib/load-error';

/**
 * A screen's main content that failed to load: what didn't load, why when that's known,
 * and a way to ask again.
 *
 * In place of the screen's empty state, never beside it: an empty list after a failed
 * request reads as "you have nothing here", which is the one wrong answer.
 */
export function LoadError({
  children,
  error,
  onRetry,
}: {
  /** What didn't load, as a sentence ("Your library didn't load."). */
  children: ReactNode;
  error?: unknown;
  /** Asks again. A promise keeps the button busy until it settles. */
  onRetry?: () => unknown;
}) {
  const [retrying, setRetrying] = useState(false);
  const detail = describeLoadError(error);

  const retry = () => {
    if (!onRetry || retrying) return;
    const result = onRetry();
    if (result instanceof Promise) {
      setRetrying(true);
      result.finally(() => setRetrying(false)).catch(() => undefined);
    }
  };

  return (
    <div
      role="alert"
      className="rounded-2xl border border-dashed border-destructive/40 p-10 text-center"
    >
      <AlertTriangle className="mx-auto mb-2 h-7 w-7 text-destructive" aria-hidden />
      <div className="text-sm font-medium text-foreground">{children}</div>
      {detail && <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{detail}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-60"
        >
          {retrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
          )}
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      )}
    </div>
  );
}
