import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '@projekt-manga/api-client';

describe('trimTrailingSlashes', () => {
  it.each([
    ['http://localhost:4000/api/', 'http://localhost:4000/api'],
    ['http://localhost:4000/api///', 'http://localhost:4000/api'],
    ['http://localhost:4000/api', 'http://localhost:4000/api'],
    ['/', ''],
    ['', ''],
  ])('turns %j into %j', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });

  it('stays fast on a long run of slashes', () => {
    const started = performance.now();
    expect(trimTrailingSlashes(`a${'/'.repeat(200_000)}b`)).toBe(`a${'/'.repeat(200_000)}b`);
    expect(trimTrailingSlashes(`a${'/'.repeat(200_000)}`)).toBe('a');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
