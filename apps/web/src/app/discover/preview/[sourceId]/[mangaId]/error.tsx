'use client';

import { useEffect, useTransition } from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import { MangaDetailBackLink } from '@/components/manga-detail/back-link';
import { recordClientError } from '@/lib/client-diagnostics';

/**
 * A source title that didn't load. Almost always the source being slow or unreachable (or
 * the connection dropping), rather than a fault in the app, so this says so and offers to
 * ask again, instead of the app-wide "unexpected error" page.
 */
export default function SourcePreviewError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const [retrying, startRetry] = useTransition();
  useEffect(() => {
    console.error(error);
    recordClientError('render', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8">
      <MangaDetailBackLink fallbackHref="/discover" fallbackLabel="Discover" />
      <div className="mx-auto mt-16 max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This title didn&apos;t load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The source didn&apos;t answer in time. It may be slow or down, or your connection may have
          dropped. Try again in a moment.
        </p>
        <button
          type="button"
          disabled={retrying}
          onClick={() => startRetry(() => retry())}
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {retrying ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RotateCw className="h-4 w-4" aria-hidden />
          )}
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      </div>
    </div>
  );
}
