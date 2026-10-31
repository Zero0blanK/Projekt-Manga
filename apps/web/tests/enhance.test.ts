import { describe, expect, it } from 'vitest';
import { shouldEnhance } from '@/lib/enhance';

describe('page enhancement', () => {
  it('enhances only pages shown larger than their own pixels', () => {
    expect(shouldEnhance(600, 900, 800)).toBe(true);
    expect(shouldEnhance(1600, 2400, 800)).toBe(false);
    // A high-density screen needs more pixels for the same size.
    expect(shouldEnhance(1000, 1500, 800, 2)).toBe(true);
  });

  it('never makes something too large to fit on the GPU, or works on nothing', () => {
    expect(shouldEnhance(2500, 3000, 4000, 2)).toBe(false);
    expect(shouldEnhance(0, 0, 800)).toBe(false);
    expect(shouldEnhance(600, 900, 0)).toBe(false);
  });
});
