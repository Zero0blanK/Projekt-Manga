import { describe, it, expect } from 'vitest';
import { StreamLimiter } from '../src/utils/streamLimiter.js';

describe('StreamLimiter', () => {
  it('caps one client without affecting another', () => {
    const limiter = new StreamLimiter(2);

    expect(limiter.acquire('a')).toBe(true);
    expect(limiter.acquire('a')).toBe(true);
    expect(limiter.acquire('a')).toBe(false);
    expect(limiter.acquire('b')).toBe(true);
  });

  it('frees a slot on release', () => {
    const limiter = new StreamLimiter(1);

    limiter.acquire('a');
    limiter.release('a');

    expect(limiter.acquire('a')).toBe(true);
  });
});
