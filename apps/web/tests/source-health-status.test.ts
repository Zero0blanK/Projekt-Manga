import { describe, expect, it } from 'vitest';
import { summarizeSourceHealth } from '@/lib/source-health-status';

const now = Date.parse('2026-10-14T12:00:00Z');
const op = (
  fields: Partial<{
    lastAttemptAt: string;
    lastSuccessAt: string | null;
    lastErrorCode: string | null;
    retryAfterAt: string | null;
  }>,
) => ({
  lastAttemptAt: '2026-10-14T11:00:00Z',
  lastSuccessAt: null,
  lastErrorCode: null,
  retryAfterAt: null,
  ...fields,
});

describe('summarizeSourceHealth', () => {
  it('is unknown before anything was attempted', () => {
    expect(summarizeSourceHealth(undefined, now)).toBe('unknown');
  });
  it('is ok when the latest attempt succeeded', () => {
    expect(
      summarizeSourceHealth(
        { sourceId: 's', browse: op({ lastSuccessAt: '2026-10-14T11:00:00Z' }), update: null },
        now,
      ),
    ).toBe('ok');
  });
  it('is failing when the latest attempt failed after the last success', () => {
    expect(
      summarizeSourceHealth(
        {
          sourceId: 's',
          browse: op({ lastSuccessAt: '2026-10-14T09:00:00Z', lastErrorCode: 'BLOCKED' }),
          update: null,
        },
        now,
      ),
    ).toBe('failing');
  });
  it('is cooling down while a retry-after is in the future', () => {
    expect(
      summarizeSourceHealth(
        {
          sourceId: 's',
          browse: op({ lastErrorCode: 'RATE_LIMITED', retryAfterAt: '2026-10-14T12:05:00Z' }),
          update: null,
        },
        now,
      ),
    ).toBe('cooling-down');
  });
});
