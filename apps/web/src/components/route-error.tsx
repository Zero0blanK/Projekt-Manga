'use client';

import { useEffect, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, Loader2, RotateCw, WifiOff } from 'lucide-react';
import { recordClientError } from '@/lib/client-diagnostics';

/**
 * A page that failed while rendering, as the route's `error.tsx` shows it.
 *
 * Errors from the server arrive here with their message stripped in production, so the
 * page can't say exactly what went wrong; it says what most likely did for this kind of
 * page (`hint`), and whether this device is offline, which it can know.
 *
 * "Try again" uses the boundary's `retry`, which fetches the page again from the server;
 * `reset` would only re-render the same failed result.
 */
export function RouteError({
  error,
  retry,
  title,
  hint,
  backHref = '/',
  backLabel = 'Back to library',
}: {
  error: unknown;
  retry: () => void;
  title: string;
  /** The likely cause for this page, in a sentence. */
  hint: ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  const [retrying, startRetry] = useTransition();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    console.error(error);
    recordClientError('render', error);
  }, [error]);

  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const Icon = offline ? WifiOff : AlertTriangle;

  return (
    <div
      role="alert"
      className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-4 py-16 text-center"
    >
      {/* The route's own metadata failed with it, so the tab would otherwise have no title. */}
      <title>{`${title} — Projekt Manga`}</title>
      <Icon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {offline
          ? "You're offline. Reconnect, then try again. Downloaded chapters still open from Downloads."
          : hint}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          disabled={retrying}
          onClick={() => startRetry(() => retry())}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {retrying ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RotateCw className="h-4 w-4" aria-hidden />
          )}
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
        <Link
          href={backHref}
          className="inline-flex items-center justify-center rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
        >
          {backLabel}
        </Link>
        {offline && (
          <Link
            href="/downloads"
            className="inline-flex items-center justify-center rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
          >
            Downloads
          </Link>
        )}
      </div>
    </div>
  );
}
