'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error stopped this page from loading. Try again, or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
