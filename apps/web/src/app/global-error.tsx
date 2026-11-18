'use client';

import { useEffect, useTransition } from 'react';
import { recordClientError } from '@/lib/client-diagnostics';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

import '@/styles.css';

/**
 * The root layout itself failed, so this replaces the whole document. It renders without
 * the app shell or its theme effect, so the saved theme is applied here the same way the
 * layout does before the first paint.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    console.error(error);
    recordClientError('render', error);
  }, [error]);

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <title>Projekt Manga didn&apos;t load</title>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <div
          role="alert"
          className="flex min-h-screen items-center justify-center bg-background px-4"
        >
          <div className="max-w-md text-center">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Projekt Manga didn&apos;t load
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Something stopped the app from starting. Try again; if it keeps happening, restart the
              app.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                disabled={retrying}
                onClick={() => startRetry(() => retry())}
                className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
              >
                {retrying ? 'Trying again…' : 'Try again'}
              </button>
              {/* A full load, not a client navigation: the app around it is what failed. */}
              <a
                href="/"
                className="inline-flex items-center justify-center rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
              >
                Reload the library
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
