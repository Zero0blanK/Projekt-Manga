'use client';

import { RouteError } from '@/components/route-error';

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This page didn't load"
      hint="Something went wrong while loading it. Try again; if it keeps happening, the library server may be down or restarting."
    />
  );
}
