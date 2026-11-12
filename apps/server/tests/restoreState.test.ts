import { describe, it, expect } from 'vitest';
import {
  ACTIVE_RESTORE_STATES,
  RESTORE_STATES,
  SYNC_CONFLICT,
  isRestoreActive,
  isRestoreState,
} from '@projekt-manga/types';

describe('restore job states', () => {
  it('recognises exactly the states of the machine', () => {
    for (const state of RESTORE_STATES) expect(isRestoreState(state)).toBe(true);
    for (const value of ['done', 'RUNNING', '', null, 3]) expect(isRestoreState(value)).toBe(false);
  });

  it('holds the library only while queued or running', () => {
    expect(RESTORE_STATES.filter(isRestoreActive)).toEqual([...ACTIVE_RESTORE_STATES]);
    expect(isRestoreActive('succeeded')).toBe(false);
    expect(isRestoreActive('failed')).toBe(false);
    expect(isRestoreActive('cancelled')).toBe(false);
  });

  it('names the two refusals of a sync push apart', () => {
    expect(SYNC_CONFLICT.resetRequired).not.toBe(SYNC_CONFLICT.restoreInProgress);
  });
});
