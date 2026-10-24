import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDesktopInitReady } from '@/lib/use-app-ready';

/**
 * The boot splash holds until this reports ready, so what it waits for *is* what the splash
 * covers.
 *
 * The bug it exists for: on desktop the library is read from a local SQLite file that the
 * shell seeds from the API in the background at launch. That read answers in milliseconds
 * whether or not the seed has written a row yet, so a launch that began with an empty
 * database saw a resolved-but-empty library, called the app ready, and lifted the splash
 * onto a blank page that filled itself in seconds later.
 *
 * Two things have to hold, and they pull in opposite directions: wait when there is genuinely
 * nothing to show, and *don't* wait when the library is already on disk — seeding re-fetches
 * every title, so waiting unconditionally would trade a blank page for a long splash.
 */
type SeedStatus = 'idle' | 'running' | 'done' | 'failed';

function installBridge(states: Array<{ seedStatus: SeedStatus; hadLocalData: boolean }>) {
  let i = 0;
  const getState = vi.fn(async () => {
    // Holds on the last entry, so a poll that keeps running sees a stable state.
    const state = states[Math.min(i, states.length - 1)];
    i++;
    return { success: true, data: { ...state, seededManga: 0 } };
  });
  (window as unknown as { desktop?: unknown }).desktop = { init: { getState } };
  return getState;
}

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
});

describe('useDesktopInitReady', () => {
  it('is ready immediately in a plain browser, where there is no shell to wait for', () => {
    const { result } = renderHook(() => useDesktopInitReady());

    expect(result.current).toBe(true);
  });

  it('waits while a seed is running on a database that started empty', async () => {
    installBridge([
      { seedStatus: 'running', hadLocalData: false },
      { seedStatus: 'running', hadLocalData: false },
      { seedStatus: 'done', hadLocalData: false },
    ]);

    const onComplete = vi.fn();
    const { result } = renderHook(() => useDesktopInitReady(onComplete));

    // Not ready while the seed is still writing — this is the regression being guarded.
    expect(result.current).toBe(false);

    await waitFor(() => expect(result.current).toBe(true));
    expect(onComplete).toHaveBeenCalled();
  });

  it('does not wait when the library is already on disk', async () => {
    // Seeding here is only a refresh of titles the reader can already see, so holding the
    // splash for it would be a long wait for nothing.
    installBridge([{ seedStatus: 'running', hadLocalData: true }]);

    const { result } = renderHook(() => useDesktopInitReady());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('refreshes the library once a background seed finishes', async () => {
    // The other half of not waiting: the rows still have to appear without a navigation.
    installBridge([
      { seedStatus: 'running', hadLocalData: true },
      { seedStatus: 'done', hadLocalData: true },
    ]);

    const onComplete = vi.fn();
    renderHook(() => useDesktopInitReady(onComplete));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it('stops waiting when the seed fails, rather than trapping the reader', async () => {
    // An unreachable API is an ordinary state for a local-first app.
    installBridge([{ seedStatus: 'failed', hadLocalData: false }]);

    const onComplete = vi.fn();
    const { result } = renderHook(() => useDesktopInitReady(onComplete));

    await waitFor(() => expect(result.current).toBe(true));
    // Nothing was seeded, so there is nothing to refresh.
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('gives up waiting if the bridge itself throws', async () => {
    (window as unknown as { desktop?: unknown }).desktop = {
      init: {
        getState: vi.fn(async () => {
          throw new Error('ipc gone');
        }),
      },
    };

    const { result } = renderHook(() => useDesktopInitReady());

    await waitFor(() => expect(result.current).toBe(true));
  });
});
