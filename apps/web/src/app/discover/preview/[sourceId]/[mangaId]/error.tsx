'use client';

import { RouteError } from '@/components/route-error';

/**
 * A source title, or its reader, that didn't load. Almost always the source being slow or
 * unreachable (or the connection dropping), rather than a fault in the app.
 */
export default function SourcePreviewError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This title didn't load"
      hint="The source didn't answer in time. It may be slow or down, or your connection may have dropped. Try again in a moment."
      backHref="/discover"
      backLabel="Back to Discover"
    />
  );
}
