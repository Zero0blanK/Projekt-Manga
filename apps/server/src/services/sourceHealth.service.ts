import type { SourceErrorCode } from '@projekt-manga/types';

type OperationHealth = {
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastErrorCode: SourceErrorCode | 'UNCLASSIFIED' | null;
  retryAfterAt: string | null;
};

type SourceHealth = {
  sourceId: string;
  browse: OperationHealth | null;
  update: OperationHealth | null;
};

const sources = new Map<string, SourceHealth>();

function getOrCreate(sourceId: string): SourceHealth {
  const current = sources.get(sourceId);
  if (current) return current;
  const created: SourceHealth = { sourceId, browse: null, update: null };
  sources.set(sourceId, created);
  return created;
}

export function recordSourceOperation(
  sourceId: string,
  operation: 'browse' | 'update',
  outcome:
    | { success: true }
    | {
        success: false;
        code: SourceErrorCode | 'UNCLASSIFIED';
        retryAfterMs?: number;
      },
): void {
  const source = getOrCreate(sourceId);
  const previous = source[operation];
  source[operation] = {
    lastAttemptAt: previous?.lastAttemptAt ?? new Date().toISOString(),
    lastSuccessAt: outcome.success ? new Date().toISOString() : (previous?.lastSuccessAt ?? null),
    lastErrorCode: outcome.success ? null : outcome.code,
    retryAfterAt:
      !outcome.success && outcome.code === 'RATE_LIMITED' && outcome.retryAfterMs
        ? new Date(Date.now() + Math.min(outcome.retryAfterMs, 24 * 60 * 60 * 1000)).toISOString()
        : null,
  };
}

export function recordSourceAttempt(sourceId: string, operation: 'browse' | 'update'): void {
  const source = getOrCreate(sourceId);
  const previous = source[operation];
  source[operation] = {
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastErrorCode: previous?.lastErrorCode ?? null,
    retryAfterAt: previous?.retryAfterAt ?? null,
  };
}

export function getSourceHealthSnapshot(): SourceHealth[] {
  return [...sources.values()].map((source) => ({ ...source }));
}

export function resetSourceHealthForTests(): void {
  sources.clear();
}
