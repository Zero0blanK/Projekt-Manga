'use client';

import { RouteError } from '@/components/route-error';

/** The title page (and its migrate screen), read from the library server. */
export default function MangaError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This title didn't load"
      hint="The library server didn't answer. It may be down or restarting; try again in a moment."
    />
  );
}
