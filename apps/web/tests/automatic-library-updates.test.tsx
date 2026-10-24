import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const {
  runLibraryUpdate,
  isLibraryUpdateRunning,
  cancelLibraryUpdate,
  setSetting,
  refresh,
  settings,
  globalIntervalHours,
  currentUser,
} = vi.hoisted(() => ({
  runLibraryUpdate: vi.fn(),
  isLibraryUpdateRunning: vi.fn(),
  cancelLibraryUpdate: vi.fn(),
  setSetting: vi.fn((key: string, value: unknown) => {
    settings[key] = value;
  }),
  refresh: vi.fn(),
  settings: {} as Record<string, unknown>,
  globalIntervalHours: { value: 6 },
  currentUser: { user: { id: 'user-1' as string | null }, loading: false },
}));
const library = [{ id: 'one', source: 'source-a', slug: 'one', title: 'One' }];
const shelf = {};

vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: library, loading: false, refresh }),
  useLibraryState: () => ({ shelf }),
}));
vi.mock('@/lib/library-update', () => ({ entriesInGlobalUpdate: () => library }));
vi.mock('@/lib/run-library-update', () => ({
  runLibraryUpdate,
  isLibraryUpdateRunning,
  cancelLibraryUpdate,
}));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => currentUser }));
vi.mock('@/lib/app-store', () => ({
  actions: { setSetting },
  useAppState: (selector: (state: { settings: Record<string, unknown> }) => unknown) =>
    selector({ settings }),
  useSetting: (key: string, fallback: unknown) =>
    key === 'automaticLibraryUpdates' ? true : fallback,
  useNumberSetting: (key: string, fallback: number) =>
    key === 'automaticLibraryUpdateIntervalHours' ? globalIntervalHours.value : fallback,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { AutomaticLibraryUpdates } = await import('@/components/automatic-library-updates');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  vi.clearAllMocks();
  for (const key of Object.keys(settings)) delete settings[key];
  globalIntervalHours.value = 6;
  currentUser.user = { id: 'user-1' };
  currentUser.loading = false;
  isLibraryUpdateRunning.mockReturnValue(false);
  runLibraryUpdate.mockImplementation(async (entries, options) => {
    for (const source of new Set(entries.map((entry) => entry.source))) {
      options.onSourceStart?.(source);
    }
    return {
      found: 0,
      failed: ['One'],
      foundBySource: {},
      failedBySource: { 'source-a': 1 },
      cancelled: false,
    };
  });
});

afterEach(() => vi.useRealTimers());

describe('Automatic library updates', () => {
  it('clears a queued update during restore and schedules it again after restore clears', async () => {
    settings['automaticLibraryUpdateLastCheckedAt:user-1:source-a'] = Date.now();
    const view = render(<AutomaticLibraryUpdates />);
    view.rerender(<AutomaticLibraryUpdates suspended />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
    });
    expect(runLibraryUpdate).not.toHaveBeenCalled();
    expect(cancelLibraryUpdate).toHaveBeenCalledTimes(1);

    view.rerender(<AutomaticLibraryUpdates suspended={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('cancels an in-flight update and ignores its completion while restore is pending', async () => {
    let finishRun: ((result: unknown) => void) | undefined;
    runLibraryUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRun = resolve;
        }),
    );
    const view = render(<AutomaticLibraryUpdates />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);
    view.rerender(<AutomaticLibraryUpdates suspended />);
    expect(cancelLibraryUpdate).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishRun?.({
        found: 1,
        failed: [],
        foundBySource: { 'source-a': 1 },
        failedBySource: {},
        cancelled: false,
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);
    view.rerender(<AutomaticLibraryUpdates suspended={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('waits for a manual run instead of starting a duplicate check', async () => {
    isLibraryUpdateRunning.mockReturnValue(true);
    const view = render(<AutomaticLibraryUpdates />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).not.toHaveBeenCalled();

    isLibraryUpdateRunning.mockReturnValue(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('does not retry a failed source before its configured minimum interval', async () => {
    const view = render(<AutomaticLibraryUpdates />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith(
      'automaticLibraryUpdateLastCheckedAt:user-1:source-a',
      expect.any(Number),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 1);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('enforces a source-specific interval longer than the global cadence', async () => {
    settings['automaticLibraryUpdateSourceIntervalHours:source-a'] = 24;
    const view = render(<AutomaticLibraryUpdates />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(18 * 60 * 60_000);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('cancels an active shared run when the signed-in account changes', () => {
    const view = render(<AutomaticLibraryUpdates />);
    currentUser.user = { id: 'user-2' };
    view.rerender(<AutomaticLibraryUpdates />);
    expect(cancelLibraryUpdate).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('clears failed-source backoff when the signed-in account changes', async () => {
    runLibraryUpdate.mockImplementation(async (_entries, options) => {
      options.onSourceStart?.('source-a');
      return {
        found: 0,
        failed: ['One'],
        foundBySource: {},
        failedBySource: { 'source-a': 1 },
        cancelled: false,
      };
    });
    const view = render(<AutomaticLibraryUpdates />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith(
      'automaticLibraryUpdateLastCheckedAt:user-1:source-a',
      expect.any(Number),
    );

    currentUser.user = { id: 'user-2' };
    view.rerender(<AutomaticLibraryUpdates />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(runLibraryUpdate).toHaveBeenCalledTimes(2);
    expect(setSetting).toHaveBeenCalledWith(
      'automaticLibraryUpdateLastCheckedAt:user-2:source-a',
      expect.any(Number),
    );
    view.unmount();
  });

  it('keeps a retry scheduled if an account switch timer fires before the old run aborts', async () => {
    let finishOldRun: ((value: { cancelled: true }) => void) | undefined;
    runLibraryUpdate.mockImplementationOnce(
      (_entries, options) =>
        new Promise((resolve) => {
          options.onSourceStart?.('source-a');
          finishOldRun = resolve;
        }),
    );
    const view = render(<AutomaticLibraryUpdates />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith(
      'automaticLibraryUpdateLastCheckedAt:user-1:source-a',
      expect.any(Number),
    );

    currentUser.user = { id: 'user-2' };
    view.rerender(<AutomaticLibraryUpdates />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runLibraryUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishOldRun?.({ cancelled: true });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(runLibraryUpdate).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
