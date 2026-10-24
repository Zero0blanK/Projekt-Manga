import { describe, expect, it } from 'vitest';
import { resolveReadingDirection } from '../src/lib/reader-settings';

describe('resolveReadingDirection', () => {
  it('uses a source override when present', () => {
    expect(resolveReadingDirection('Right to left', 'Left to right')).toBe('Left to right');
  });

  it('falls back to the global preference for missing or default overrides', () => {
    expect(resolveReadingDirection('Right to left')).toBe('Right to left');
    expect(resolveReadingDirection('Vertical (webtoon)', 'Use default')).toBe('Vertical (webtoon)');
  });
});
