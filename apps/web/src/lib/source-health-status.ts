'use client';

import { useQuery } from '@tanstack/react-query';
import { getSourceHealth, type SourceHealth } from '@projekt-manga/api-client';

export type SourceHealthStatus = 'ok' | 'failing' | 'cooling-down' | 'unknown';

/**
 * Reduces a source's recorded browse/update outcomes to one reader-facing state:
 * cooling down while a retry-after is in the future, failing when the latest attempt
 * failed (an error newer than the last success), otherwise ok.
 */
export function summarizeSourceHealth(
  entry: SourceHealth | undefined,
  now = Date.now(),
): SourceHealthStatus {
  const operations = [entry?.browse, entry?.update].filter(
    (operation): operation is NonNullable<typeof operation> => !!operation,
  );
  if (!operations.length) return 'unknown';
  if (operations.some((op) => op.retryAfterAt && Date.parse(op.retryAfterAt) > now))
    return 'cooling-down';
  const latest = operations.reduce((a, b) =>
    Date.parse(a.lastAttemptAt) >= Date.parse(b.lastAttemptAt) ? a : b,
  );
  const failedLast =
    !!latest.lastErrorCode &&
    (!latest.lastSuccessAt || Date.parse(latest.lastSuccessAt) < Date.parse(latest.lastAttemptAt));
  return failedLast ? 'failing' : 'ok';
}

/** One shared request for every source card on the page (React Query dedupes it). */
export function useSourceHealthStatus(sourceId: string): SourceHealthStatus {
  const { data } = useQuery({
    queryKey: ['source-health'],
    queryFn: ({ signal }) => getSourceHealth(signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  return summarizeSourceHealth(data?.find((entry) => entry.sourceId === sourceId));
}
