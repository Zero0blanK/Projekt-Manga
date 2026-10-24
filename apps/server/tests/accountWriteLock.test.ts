import { describe, expect, it } from 'vitest';
import { withAccountWriteLock } from '../src/utils/accountWriteLock.js';

describe('account write serialization', () => {
  it('waits for an earlier write on the same account but not a different account', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withAccountWriteLock('account-a', async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('first-end');
    });
    const second = withAccountWriteLock('account-a', async () => {
      order.push('second');
    });
    await withAccountWriteLock('account-b', async () => {
      order.push('other');
    });
    expect(order).toEqual(['first-start', 'other']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'other', 'first-end', 'second']);
  });
});
