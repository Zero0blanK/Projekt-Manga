import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { actions, getAppState } from '@/lib/app-store';
import { queryClient, queryKeys } from '@/lib/query-client';
import {
  EMPTY_IDS,
  parseIdList,
  parsePreference,
  profilePreferenceKey,
  useProfilePreference,
} from '@/lib/profile-preferences';

const identity = vi.hoisted(() => ({ user: { id: 'a' } }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: identity.user, loading: false }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast }));
beforeEach(() => {
  actions.resetAll();
  queryClient.clear();
  identity.user = { id: 'a' };
  queryClient.setQueryData(queryKeys.session, identity.user);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  actions.resetAll();
  queryClient.clear();
  toast.mockClear();
});

describe('profile preference persistence', () => {
  it('validates versions, corrupt data and duplicate IDs', () => {
    expect(parsePreference('{bad', parseIdList, ['fallback'])).toEqual(['fallback']);
    expect(
      parsePreference(JSON.stringify({ version: 2, value: ['a'] }), parseIdList, ['fallback']),
    ).toEqual(['fallback']);
    expect(
      parsePreference(
        JSON.stringify({ version: 1, value: ['a', 'a', null, 'b'] }),
        parseIdList,
        [],
      ),
    ).toEqual(['a', 'b']);
    expect(profilePreferenceKey('queue', 'account:a')).not.toBe(
      profilePreferenceKey('queue', 'account'),
    );
  });
  it('applies functional updates to the latest stored value without losing batched changes', () => {
    const { result } = renderHook(() => useProfilePreference('queue', parseIdList, EMPTY_IDS));
    act(() => {
      result.current[1]((ids) => [...ids, 'one']);
      result.current[1]((ids) => [...ids, 'two']);
    });
    expect(result.current[0]).toEqual(['one', 'two']);
    expect(JSON.parse(String(getAppState().settings[profilePreferenceKey('queue', 'a')]))).toEqual({
      version: 1,
      value: ['one', 'two'],
    });
  });
  it('rejects an old setter after the current account changes', () => {
    const { result, rerender } = renderHook(() =>
      useProfilePreference('queue', parseIdList, EMPTY_IDS),
    );
    const previousSetter = result.current[1];
    identity.user = { id: 'b' };
    queryClient.setQueryData(queryKeys.session, identity.user);
    rerender();
    act(() => previousSetter(['private-a']));
    expect(getAppState().settings[profilePreferenceKey('queue', 'a')]).toBeUndefined();
    expect(result.current[0]).toEqual([]);
    act(() => result.current[1](['private-b']));
    expect(result.current[0]).toEqual(['private-b']);
  });
  it('reports unavailable device storage while preserving the session value', () => {
    const { result } = renderHook(() => useProfilePreference('queue', parseIdList, EMPTY_IDS));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    act(() => result.current[1](['one']));
    expect(result.current[0]).toEqual(['one']);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('saved for this session only'),
      }),
    );
  });
});
