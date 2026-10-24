import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNewSinceLastVisit, readSeenChapters } from '@/lib/chapter-visits';
import { useAutoAdvanceCountdown } from '@/lib/auto-advance';

// Node's own (file-backed) localStorage global shadows jsdom's here, so use an in-memory one.
const values = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => Array.from(values.keys())[index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, String(value)),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage });
Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage });

afterEach(() => {
  values.clear();
  vi.useRealTimers();
});

describe('new chapters since the last visit', () => {
  it('marks nothing on a first visit and records the list', () => {
    const { result } = renderHook(() => useNewSinceLastVisit('me', 'm1', ['a', 'b'], true));
    expect(result.current.size).toBe(0);
    expect(readSeenChapters('me', 'm1')).toEqual(new Set(['a', 'b']));
  });

  it('marks chapters that arrived since the previous visit, and keeps them for the visit', () => {
    renderHook(() => useNewSinceLastVisit('me', 'm1', ['a'], true)).unmount();

    const { result, rerender } = renderHook(
      ({ ids }) => useNewSinceLastVisit('me', 'm1', ids, true),
      { initialProps: { ids: ['a', 'b'] } },
    );
    expect([...result.current]).toEqual(['b']);

    // A re-check during the visit finds one more; the earlier arrival stays marked.
    rerender({ ids: ['a', 'b', 'c'] });
    expect([...result.current].sort()).toEqual(['b', 'c']);

    // The next visit only marks what arrives after this one.
    renderHook(() => useNewSinceLastVisit('me', 'm1', ['a', 'b', 'c'], true));
    const next = renderHook(() => useNewSinceLastVisit('me', 'm1', ['a', 'b', 'c'], true));
    expect(next.result.current.size).toBe(0);
  });

  it('keeps each profile and title separate', () => {
    renderHook(() => useNewSinceLastVisit('me', 'm1', ['a'], true)).unmount();
    const other = renderHook(() => useNewSinceLastVisit('you', 'm1', ['a', 'b'], true));
    expect(other.result.current.size).toBe(0);
  });

  it('waits for the list to load before recording anything', () => {
    renderHook(() => useNewSinceLastVisit('me', 'm1', ['a'], false));
    expect(readSeenChapters('me', 'm1')).toBeNull();
  });
});

describe('auto-advance countdown', () => {
  it('counts down and then advances once', () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const { result } = renderHook(() => useAutoAdvanceCountdown(true, 'ch1', onAdvance, 3));
    expect(result.current.secondsLeft).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.secondsLeft).toBe(2);
    act(() => vi.advanceTimersByTime(2000));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(result.current.secondsLeft).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('stays put when cancelled, even when the last page shows again', () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const { result, rerender } = renderHook(
      ({ armed }) => useAutoAdvanceCountdown(armed, 'ch1', onAdvance, 3),
      { initialProps: { armed: true } },
    );
    act(() => result.current.cancel());
    expect(result.current.secondsLeft).toBeNull();
    rerender({ armed: false });
    rerender({ armed: true });
    act(() => vi.advanceTimersByTime(5000));
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('resets when the reader leaves the last page', () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const { result, rerender } = renderHook(
      ({ armed }) => useAutoAdvanceCountdown(armed, 'ch1', onAdvance, 3),
      { initialProps: { armed: true } },
    );
    act(() => vi.advanceTimersByTime(2000));
    rerender({ armed: false });
    expect(result.current.secondsLeft).toBeNull();
    rerender({ armed: true });
    expect(result.current.secondsLeft).toBe(3);
    act(() => vi.advanceTimersByTime(2000));
    expect(onAdvance).not.toHaveBeenCalled();
  });
});
