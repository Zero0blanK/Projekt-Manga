import { currentRequestId } from './requestContext.js';

export type DiagnosticArea = 'api' | 'download' | 'restore' | 'sync';
export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticEvent {
  at: string;
  level: DiagnosticLevel;
  area: DiagnosticArea;
  event: string;
  requestId: string | null;
  jobId: string | null;
  code: string | null;
  counts: Record<string, number>;
}

const MAX_EVENTS = 200;
const recentEvents: DiagnosticEvent[] = [];
const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const SAFE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Z0-9_]{1,48}$/;
const SAFE_EVENT = /^[a-z][a-z0-9_.-]{1,63}$/;
const SAFE_COUNT = /^[a-z][a-zA-Z0-9_]{0,31}$/;

/** Stores a bounded, allowlisted operational event. Free-form messages and paths are never accepted. */
export function recordDiagnosticEvent(input: {
  level: DiagnosticLevel;
  area: DiagnosticArea;
  event: string;
  requestId?: string | null;
  jobId?: string | null;
  code?: string | null;
  counts?: Record<string, number>;
}): void {
  if (!SAFE_EVENT.test(input.event)) return;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(input.counts ?? {}).slice(0, 8)) {
    if (SAFE_COUNT.test(key) && Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  recentEvents.push({
    at: new Date().toISOString(),
    level: input.level,
    area: input.area,
    event: input.event,
    requestId: (() => {
      const requestId = input.requestId ?? currentRequestId();
      return requestId && SAFE_REQUEST_ID.test(requestId) ? requestId : null;
    })(),
    jobId: input.jobId && SAFE_ID.test(input.jobId) ? input.jobId : null,
    code: input.code && SAFE_CODE.test(input.code) ? input.code : null,
    counts,
  });
  if (recentEvents.length > MAX_EVENTS) recentEvents.splice(0, recentEvents.length - MAX_EVENTS);
}

/** The report endpoint returns only the newest 40 entries from this 200-entry ring. */
export function getRecentDiagnosticEvents(): DiagnosticEvent[] {
  return recentEvents.slice(-40).map((entry) => ({ ...entry, counts: { ...entry.counts } }));
}

export function resetDiagnosticEventsForTests(): void {
  recentEvents.length = 0;
}
