import { describe, expect, it } from 'vitest';
import { isQuietHours } from '../src/lib/notification-preferences';

describe('isQuietHours', () => {
  it('handles intervals crossing midnight and their exclusive end', () => {
    expect(isQuietHours(new Date(2026, 0, 1, 23, 0), '22:00', '07:00')).toBe(true);
    expect(isQuietHours(new Date(2026, 0, 1, 6, 59), '22:00', '07:00')).toBe(true);
    expect(isQuietHours(new Date(2026, 0, 1, 7, 0), '22:00', '07:00')).toBe(false);
  });

  it('handles same-day intervals and rejects malformed or disabled intervals', () => {
    expect(isQuietHours(new Date(2026, 0, 1, 12, 0), '09:00', '17:00')).toBe(true);
    expect(isQuietHours(new Date(2026, 0, 1, 18, 0), '09:00', '17:00')).toBe(false);
    expect(isQuietHours(new Date(2026, 0, 1, 12, 0), '12:00', '12:00')).toBe(false);
    expect(isQuietHours(new Date(2026, 0, 1, 12, 0), 'bad', '17:00')).toBe(false);
  });
});
