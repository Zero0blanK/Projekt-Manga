'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSourceHealth, getScraperHealth, type SourceHealth } from '@projekt-manga/api-client';
import { SUPPORTED_EXTENSION_API_VERSION } from '@projekt-manga/schemas';
export function useSourceHealthSummary() {
  const [health, setHealth] = useState<SourceHealth[]>([]);
  const [breakers, setBreakers] = useState<
    NonNullable<Awaited<ReturnType<typeof getScraperHealth>>['circuitBreakers']>
  >([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      getSourceHealth(controller.signal),
      getScraperHealth(controller.signal),
    ]).then(([operations, scraper]) => {
      if (controller.signal.aborted) return;
      setUnavailable(operations.status === 'rejected');
      if (operations.status === 'fulfilled') setHealth(operations.value);
      if (scraper.status === 'fulfilled') setBreakers(scraper.value.circuitBreakers ?? []);
    });
    return () => controller.abort();
  }, []);
  return { health, breakers, unavailable };
}
export function SourceHealthSummary({
  sourceId,
  apiVersion,
  snapshot,
}: {
  sourceId: string;
  apiVersion?: number;
  snapshot: ReturnType<typeof useSourceHealthSummary>;
}) {
  const operation = snapshot.health.find((entry) => entry.sourceId === sourceId)?.browse;
  const breaker = snapshot.breakers.find((entry) => entry.source === sourceId);
  return (
    <Link
      href="/settings#about"
      className="mt-2 block text-[11px] text-muted-foreground hover:text-foreground"
    >
      {apiVersion !== undefined &&
        `API v${apiVersion} ${apiVersion <= SUPPORTED_EXTENSION_API_VERSION ? 'compatible' : 'unsupported'} · `}
      {snapshot.unavailable
        ? 'Health unavailable'
        : operation?.lastSuccessAt
          ? `Last success: ${new Date(operation.lastSuccessAt).toLocaleString()}`
          : 'Not checked since server start'}
      {operation?.lastErrorCode && ` · Latest failure: ${operation.lastErrorCode}`}
      {operation?.retryAfterAt &&
        Date.parse(operation.retryAfterAt) > Date.now() &&
        ` · Cooldown until ${new Date(operation.retryAfterAt).toLocaleTimeString()}`}
      {breaker?.isOpen && ` · Circuit cooldown: ${Math.ceil(breaker.openRemainingMs / 1000)}s`}
      <span className="ml-1 underline">Source health</span>
    </Link>
  );
}
