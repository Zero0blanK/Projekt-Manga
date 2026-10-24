import { describe, it, expect, vi } from 'vitest';
import {
  retryAfterMs,
  isRateLimited,
  requestWithRetry,
  toTrackerError,
} from '../src/services/trackers/httpRetry.js';
import { RateLimitedError, UpstreamError } from '../src/utils/customErrors.js';

function rateLimited(headers: Record<string, string> = {}) {
  return { response: { status: 429, headers } };
}

describe('retryAfterMs', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');

  it('reads Retry-After as delta-seconds', () => {
    expect(retryAfterMs({ 'retry-after': '30' }, now)).toBe(30_000);
  });

  it('reads Retry-After as an HTTP date', () => {
    expect(retryAfterMs({ 'retry-after': 'Fri, 28 Aug 2026 12:00:45 GMT' }, now)).toBe(45_000);
  });

  it("falls back to AniList's X-RateLimit-Reset, which is unix *seconds* not milliseconds", () => {
    expect(retryAfterMs({ 'x-ratelimit-reset': String(now / 1000 + 20) }, now)).toBe(20_000);
  });

  it('never returns a negative wait for an already-past reset', () => {
    expect(retryAfterMs({ 'retry-after': 'Fri, 28 Aug 2026 11:59:00 GMT' }, now)).toBe(0);
  });

  it('returns null when the response said nothing usable', () => {
    expect(retryAfterMs({ 'retry-after': 'soon-ish' }, now)).toBeNull();
    expect(retryAfterMs(undefined, now)).toBeNull();
  });
});

describe('isRateLimited', () => {
  it('recognises a 429 without relying on axios helpers', () => {
    // The server suite mocks axios as a bare object, so axios.isAxiosError doesn't exist
    // here — the duck-typed check is what keeps this working in both worlds.
    expect(isRateLimited(rateLimited())).toBe(true);
    expect(isRateLimited({ response: { status: 500 } })).toBe(false);
    expect(isRateLimited(new Error('socket hang up'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});

describe('requestWithRetry', () => {
  it('retries a 429 for as long as the tracker asked, then returns the success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimited({ 'retry-after': '0' }))
      .mockResolvedValueOnce('ok');

    await expect(requestWithRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up rather than sleeping when the tracker asks for longer than the ceiling', async () => {
    const fn = vi.fn().mockRejectedValue(rateLimited({ 'retry-after': '600' }));

    await expect(requestWithRetry(fn)).rejects.toMatchObject({ response: { status: 429 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry anything other than a 429 — a 500 or a timeout is surfaced immediately', async () => {
    const serverError = vi.fn().mockRejectedValue({ response: { status: 500 } });
    await expect(requestWithRetry(serverError)).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(serverError).toHaveBeenCalledTimes(1);

    const timeout = vi.fn().mockRejectedValue(new Error('timeout of 15000ms exceeded'));
    await expect(requestWithRetry(timeout)).rejects.toThrow('timeout');
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it('stops after a bounded number of attempts instead of retrying a persistent 429 forever', async () => {
    const fn = vi.fn().mockRejectedValue(rateLimited({ 'retry-after': '0' }));

    await expect(requestWithRetry(fn)).rejects.toMatchObject({ response: { status: 429 } });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('toTrackerError', () => {
  it('maps a 429 to RateLimitedError so it reaches the client as a 429, not a generic upstream failure', () => {
    expect(() => toTrackerError(rateLimited(), 'AniList')).toThrow(RateLimitedError);
    try {
      toTrackerError(rateLimited(), 'AniList');
    } catch (error) {
      expect((error as RateLimitedError).statusCode).toBe(429);
      expect((error as Error).message).toContain('AniList');
    }
  });

  it('maps anything else to UpstreamError', () => {
    expect(() => toTrackerError(new Error('socket hang up'), 'MyAnimeList')).toThrow(UpstreamError);
  });
});
