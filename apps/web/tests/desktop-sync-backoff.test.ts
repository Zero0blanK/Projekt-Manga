import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { localInvoke, getSetting } = vi.hoisted(() => ({
  localInvoke: vi.fn(),
  getSetting: vi.fn((_key: string, fallback: unknown) => fallback),
}));

vi.mock('@projekt-manga/api-client', () => ({
  hasLocalDataBridge: () => true,
  localInvoke,
}));
vi.mock('@/lib/app-store', () => ({ getSetting }));

import { runDesktopSync, setDesktopSyncAccount, useDesktopSyncState } from '@/lib/desktop-sync';
import { act, renderHook } from '@testing-library/react';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  vi.resetAllMocks();
  getSetting.mockImplementation((_key: string, fallback: unknown) => fallback);
});

afterEach(() => vi.useRealTimers());

describe('desktop sync retry backoff', () => {
  it('does not run when sync is disabled in this device settings', async () => {
    getSetting.mockReturnValue(false);
    await act(async () => runDesktopSync());
    expect(localInvoke).not.toHaveBeenCalled();
  });

  it('doubles retry delays after failures and resets when the account changes', async () => {
    const { result } = renderHook(() => useDesktopSyncState());
    act(() => setDesktopSyncAccount('backoff-test-account'));
    localInvoke.mockRejectedValue(new Error('fixture offline'));

    await act(async () => runDesktopSync());
    expect(result.current.retryAfter).toBe(Date.now() + 60_000);

    await act(async () => runDesktopSync());
    expect(result.current.retryAfter).toBe(Date.now() + 2 * 60_000);

    act(() => setDesktopSyncAccount('backoff-test-account-next'));
    expect(result.current.retryAfter).toBeNull();
    await act(async () => runDesktopSync());
    expect(result.current.retryAfter).toBe(Date.now() + 60_000);
  });
});
