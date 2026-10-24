import { afterEach, describe, expect, it } from 'vitest';
import {
  getRecentDiagnosticEvents,
  recordDiagnosticEvent,
  resetDiagnosticEventsForTests,
} from '../../src/utils/diagnosticLog.js';
import { withRequestId } from '../../src/utils/requestContext.js';

afterEach(resetDiagnosticEventsForTests);

describe('bounded diagnostic events', () => {
  it('keeps a bounded report tail and captures validated request/job identifiers', () => {
    const requestId = 'c3f6b9d4-55af-45f0-9867-265a801acd12';
    withRequestId(requestId, () => {
      recordDiagnosticEvent({
        level: 'error',
        area: 'sync',
        event: 'sync.push.failed',
        jobId: 'sync_job-1',
        code: 'DATABASE_ERROR',
        counts: { failed: 2, invalid: -1, detail: Number.NaN },
      });
    });
    expect(getRecentDiagnosticEvents()[0].requestId).toBe(requestId);
    for (let index = 0; index < 210; index += 1) {
      recordDiagnosticEvent({
        level: 'info',
        area: 'download',
        event: 'download.progress',
        counts: { completed: index },
      });
    }

    const events = getRecentDiagnosticEvents();
    expect(events).toHaveLength(40);
    expect(events.at(-1)?.counts).toEqual({ completed: 209 });
    expect(events.some((event) => event.requestId === requestId)).toBe(false);
  });

  it('drops invalid identifiers and nonnumeric diagnostic values', () => {
    recordDiagnosticEvent({
      level: 'warn',
      area: 'api',
      event: 'api.failure',
      requestId: 'C:\\Users\\person\\private',
      jobId: 'https://example.test/private?token=secret',
      code: 'private token',
      counts: { ok: 1.5, valid: 1 },
    });

    expect(getRecentDiagnosticEvents()[0]).toMatchObject({
      requestId: null,
      jobId: null,
      code: null,
      counts: { valid: 1 },
    });
    expect(JSON.stringify(getRecentDiagnosticEvents())).not.toMatch(/private|secret|Users/i);
  });
});
