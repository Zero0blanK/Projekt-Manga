'use client';

import { RouteError } from '@/components/route-error';

/** The reader for a library title. Opens from the library server; pages that fail inside
 * the reader have their own retry, so this is the reader not opening at all. */
export default function ReaderError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="The reader didn't open"
      hint="The library server didn't answer. It may be down or restarting; try again in a moment, or read a downloaded chapter."
    />
  );
}
