import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { markChapterByLastPage, addHistory, incognito, beacons, takeElapsed } = vi.hoisted(() => ({
  takeElapsed: () => 5,
  markChapterByLastPage: vi.fn(),
  addHistory: vi.fn(),
  incognito: { on: false },
  beacons: vi.fn(),
}));

vi.mock('@projekt-manga/api-client', () => ({
  markChapterByLastPage,
  addHistory,
  buildApiUrl: (path: string) => path,
  usesLocalFirstDataSync: () => false,
}));
vi.mock('@/lib/incognito', () => ({
  isSourceIncognito: () => incognito.on,
  useSourceIncognito: () => incognito.on,
}));
vi.mock('@/lib/query-client', () => ({ invalidateSavedReadingProgress: vi.fn() }));
vi.mock('@/lib/reader-progress-beacon', () => ({ queueReaderProgressBeacons: beacons }));
vi.mock('@/lib/report-error', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/use-reading-clock', () => ({ useReadingClock: () => takeElapsed }));

import { useAutoMarkRead, useReaderProgress } from '@/components/reader/use-reader-progress';

const target = { source: 'src', mangaSlug: 'slug', history: { title: 'A title' } };
const at = (page: number, key = 'ch-1') => ({
  sourceChapterKey: key,
  page,
  pageCount: 20,
  body: { page_count: 20, source: 'src' },
});
const settle = () => act(() => vi.advanceTimersByTimeAsync(800));

beforeEach(() => {
  vi.useFakeTimers();
  incognito.on = false;
  markChapterByLastPage.mockReset().mockResolvedValue(undefined);
  addHistory.mockReset().mockResolvedValue(undefined);
  beacons.mockReset().mockReturnValue({ progressQueued: true, historyQueued: true });
});
afterEach(() => vi.useRealTimers());

describe('useReaderProgress', () => {
  it('saves once for a burst of page turns, at the newest page', async () => {
    const { rerender } = renderHook(({ page }) => useReaderProgress(target, at(page)), {
      initialProps: { page: 1 },
    });
    rerender({ page: 2 });
    rerender({ page: 3 });
    await settle();

    expect(markChapterByLastPage).toHaveBeenCalledTimes(1);
    expect(markChapterByLastPage).toHaveBeenCalledWith('slug', 'ch-1', 3, at(3).body);
    expect(addHistory).toHaveBeenCalledTimes(1);
  });

  it('saves nothing until there is a position', async () => {
    renderHook(() => useReaderProgress(target, null));
    await settle();

    expect(markChapterByLastPage).not.toHaveBeenCalled();
  });

  it('saves nothing in incognito', async () => {
    incognito.on = true;
    renderHook(() => useReaderProgress(target, at(3)));
    await settle();

    expect(markChapterByLastPage).not.toHaveBeenCalled();
    expect(addHistory).not.toHaveBeenCalled();
  });

  it('uses a beacon on pagehide, so the save outlives the tab', () => {
    renderHook(() => useReaderProgress(target, at(3)));

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(beacons).toHaveBeenCalledTimes(1);
    expect(markChapterByLastPage).not.toHaveBeenCalled();
  });

  it('flushes the old chapter before moving to another', async () => {
    const { result, rerender } = renderHook(({ key }) => useReaderProgress(target, at(4, key)), {
      initialProps: { key: 'ch-1' },
    });
    act(() => result.current.flushProgress());
    rerender({ key: 'ch-2' });
    await settle();

    expect(markChapterByLastPage.mock.calls.map((call) => call[1])).toEqual(['ch-1', 'ch-2']);
  });

  it('keeps a failed write and sends it with its reading time on the next flush', async () => {
    markChapterByLastPage.mockRejectedValueOnce(new Error('offline'));
    addHistory.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useReaderProgress(target, at(3)));
    await settle();

    await act(async () => {
      result.current.flushProgress();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(markChapterByLastPage).toHaveBeenCalledTimes(2);
    expect(addHistory.mock.calls[1][0].time_read).toBe(10);
  });
});

describe('useAutoMarkRead', () => {
  it('marks once, and may try again after a failure', async () => {
    const mark = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { rerender } = renderHook(({ id }) => useAutoMarkRead(id, mark), {
      initialProps: { id: 'ch-1' as string | null },
    });
    await act(() => vi.advanceTimersByTimeAsync(0));

    rerender({ id: null });
    rerender({ id: 'ch-1' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ id: null });
    rerender({ id: 'ch-1' });

    expect(mark).toHaveBeenCalledTimes(2);
  });
});
