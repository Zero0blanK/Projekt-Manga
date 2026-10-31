import { describe, expect, it } from 'vitest';
import { mergeVisibleOrder } from '@/hooks/use-drag-reorder';

describe('mergeVisibleOrder', () => {
  it('reorders the rows a filter shows and leaves hidden ones in place', () => {
    expect(mergeVisibleOrder(['a', 'b', 'c', 'd'], ['d', 'b'])).toEqual(['a', 'd', 'c', 'b']);
    expect(mergeVisibleOrder(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a']);
  });
});
