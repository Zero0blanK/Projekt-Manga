import { describe, it, expect } from 'vitest';
import { parseDateToIso } from '../utils/parse.js';

/** Characterization tests for the pure date-parsing helper in utils/parse.ts. */
describe('parseDateToIso', () => {
  it('returns an empty string for empty input', () => {
    expect(parseDateToIso('')).toBe('');
  });

  it('parses an absolute date string', () => {
    const iso = parseDateToIso('January 5, 2024');
    expect(iso).toBe(new Date('January 5, 2024').toISOString());
  });

  it('parses a datetime attribute value', () => {
    const iso = parseDateToIso('2024-03-15T10:30:00Z');
    expect(iso).toBe('2024-03-15T10:30:00.000Z');
  });

  it('normalizes non-breaking spaces and abbreviated months before parsing', () => {
    const iso = parseDateToIso('Mar. 15, 2024');
    expect(iso).toBe(new Date('Mar 15, 2024').toISOString());
  });

  it('falls back to a relative "X days ago" style string', () => {
    const now = Date.now();
    const iso = parseDateToIso('3 days ago');
    const parsed = new Date(iso).getTime();
    const expectedMs = now - 3 * 24 * 60 * 60 * 1000;
    // Allow slack for the time the test itself takes to run.
    expect(Math.abs(parsed - expectedMs)).toBeLessThan(5000);
  });

  it('combines multiple relative units', () => {
    const now = Date.now();
    const iso = parseDateToIso('1 year 2 months ago');
    const parsed = new Date(iso).getTime();
    const expectedMs = now - (365 + 2 * 30) * 24 * 60 * 60 * 1000;
    expect(Math.abs(parsed - expectedMs)).toBeLessThan(5000);
  });

  it('returns an empty string for unparseable garbage', () => {
    expect(parseDateToIso('not a date at all')).toBe('');
  });
});
