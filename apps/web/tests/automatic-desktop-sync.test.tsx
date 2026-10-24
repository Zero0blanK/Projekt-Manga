import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const { runDesktopSync, setDesktopSyncAccount, settings } = vi.hoisted(() => ({
  runDesktopSync: vi.fn(),
  setDesktopSyncAccount: vi.fn(),
  settings: {} as Record<string, unknown>,
}));
const retryAfter = new Date('2026-01-01T12:02:00Z').getTime();

vi.mock('@projekt-manga/api-client', () => ({ hasLocalDataBridge: () => true }));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: { id: 'account-1' } }),
}));
vi.mock('@/lib/app-store', () => ({
  useSetting: (key: string, fallback: unknown) => settings[key] ?? fallback,
}));
vi.mock('@/lib/desktop-sync', () => ({
  runDesktopSync,
  setDesktopSyncAccount,
  useDesktopSyncState: () => ({
    lastSuccess: null,
    lastAttempt: null,
    retryAfter,
    running: false,
  }),
}));

import { AutomaticDesktopSync } from '@/components/automatic-desktop-sync';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  vi.clearAllMocks();
  Object.keys(settings).forEach((key) => delete settings[key]);
  runDesktopSync.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe('Automatic desktop sync scheduling', () => {
  it('waits for the backoff deadline, then retries once while the app is visible', async () => {
    const view = render(<AutomaticDesktopSync ready />);
    expect(runDesktopSync).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_999);
    });
    expect(runDesktopSync).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(runDesktopSync).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('does not schedule sync when this device has sync paused', async () => {
    settings.desktopSyncEnabled = false;
    const view = render(<AutomaticDesktopSync ready />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(runDesktopSync).not.toHaveBeenCalled();
    view.unmount();
  });
});
