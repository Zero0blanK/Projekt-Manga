import { describe, it, expect } from 'vitest';
import { SourceCircuitBreaker } from '../features/SourceCircuitBreaker.js';

describe('SourceCircuitBreaker', () => {
  it('stays closed below the failure threshold', () => {
    const breaker = new SourceCircuitBreaker(3, 1000);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    expect(breaker.getOpenRemainingMs('siteA')).toBe(0);
  });

  it('opens once consecutive failures reach the threshold', () => {
    const breaker = new SourceCircuitBreaker(3, 1000);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    expect(breaker.getOpenRemainingMs('siteA')).toBeGreaterThan(0);
  });

  it('reports isOpen/consecutiveFailures via getStats()', () => {
    const breaker = new SourceCircuitBreaker(2, 1000);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    const stats = breaker.getStats();
    expect(stats).toEqual([
      expect.objectContaining({ source: 'siteA', consecutiveFailures: 2, isOpen: true }),
    ]);
  });

  it('closes again on success, resetting the failure count', () => {
    const breaker = new SourceCircuitBreaker(3, 1000);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    breaker.recordSuccess('siteA');
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    // Only 2 consecutive failures since the success reset the counter — still closed.
    expect(breaker.getOpenRemainingMs('siteA')).toBe(0);
  });

  it('goes half-open after the cooldown elapses, allowing one attempt through', async () => {
    const breaker = new SourceCircuitBreaker(2, 30);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    expect(breaker.getOpenRemainingMs('siteA')).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 50));

    expect(breaker.getOpenRemainingMs('siteA')).toBe(0);
    // Half-open: consecutiveFailures reset and no longer reported as open, even though
    // the entry itself isn't deleted (getOpenRemainingMs resets it in place).
    expect(breaker.getStats()).toEqual([
      expect.objectContaining({ source: 'siteA', consecutiveFailures: 0, isOpen: false }),
    ]);
  });

  it('re-opens if the half-open attempt also fails', async () => {
    const breaker = new SourceCircuitBreaker(2, 30);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    await new Promise((r) => setTimeout(r, 50));
    expect(breaker.getOpenRemainingMs('siteA')).toBe(0); // half-open, counter reset

    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    expect(breaker.getOpenRemainingMs('siteA')).toBeGreaterThan(0);
  });

  it('tracks each source independently', () => {
    const breaker = new SourceCircuitBreaker(2, 1000);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteB');

    expect(breaker.getOpenRemainingMs('siteA')).toBeGreaterThan(0);
    expect(breaker.getOpenRemainingMs('siteB')).toBe(0);
  });

  it('reset() clears one source without affecting others', () => {
    const breaker = new SourceCircuitBreaker(1, 1000);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteB');
    breaker.reset('siteA');

    expect(breaker.getOpenRemainingMs('siteA')).toBe(0);
    expect(breaker.getOpenRemainingMs('siteB')).toBeGreaterThan(0);
  });

  it('reset() with no argument clears every source', () => {
    const breaker = new SourceCircuitBreaker(1, 1000);
    breaker.recordFailure('siteA');
    breaker.recordFailure('siteB');
    breaker.reset();

    expect(breaker.getStats()).toEqual([]);
  });
});
