import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toast, toastWithUndo } = vi.hoisted(() => ({ toast: vi.fn(), toastWithUndo: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ toast }));
vi.mock('@/lib/undo-toast', () => ({ toastWithUndo }));

import { useChapterMarking, type ChapterMarkingAdapter } from '@/lib/chapter-marking';

type Row = { id: string; n: number };

/** A promise the test settles by hand, to hold a save open while something else happens. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A chapter list as the module sees one: chapters 1…5, read state in a set. */
function list(overrides: Partial<ChapterMarkingAdapter<Row>> = {}) {
  const rows: Row[] = [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, n }));
  const read = new Set<string>();
  const state = { current: true };
  const adapter: ChapterMarkingAdapter<Row> = {
    begin: () => () => state.current,
    rows: () => rows,
    id: (row) => row.id,
    sourceKey: (row) => `key-${row.id}`,
    chapterNumber: (row) => row.n,
    isRead: (row) => read.has(row.id),
    setRead: (changes) => {
      for (const [id, isRead] of changes) {
        if (isRead) read.add(id);
        else read.delete(id);
      }
    },
    mark: vi.fn(async () => undefined),
    markMany: vi.fn(async (targets: Row[]) => ({
      count: targets.length,
      failed_source_chapter_keys: [],
    })),
    onMarked: vi.fn(),
    onManyMarked: vi.fn(),
    undoMany: vi.fn(async () => undefined),
    ...overrides,
  };
  const { result } = renderHook(() => useChapterMarking(adapter));
  return { marking: result.current, adapter, rows, read, state };
}

const readIds = (read: Set<string>) => [...read].sort();
const descriptions = () => toast.mock.calls.map(([arg]) => arg.description);

beforeEach(() => {
  toast.mockClear();
  toastWithUndo.mockClear();
});

describe('marking one chapter', () => {
  it('shows the change at once and keeps it when saved', async () => {
    const { marking, adapter, rows, read } = list();
    let saved: boolean | undefined;
    await act(async () => {
      const pending = marking.toggleRead(rows[0]);
      expect(readIds(read)).toEqual(['c1']);
      saved = await pending;
    });
    expect(saved).toBe(true);
    expect(adapter.mark).toHaveBeenCalledWith(rows[0], true);
    expect(adapter.onMarked).toHaveBeenCalledWith(rows[0], true, expect.any(Function));
    expect(readIds(read)).toEqual(['c1']);
  });

  it('puts the chapter back and says so when the save fails', async () => {
    const { marking, rows, read } = list({ mark: vi.fn(async () => Promise.reject(new Error())) });
    let saved: boolean | undefined;
    await act(async () => {
      saved = await marking.toggleRead(rows[0]);
    });
    expect(saved).toBe(false);
    expect(readIds(read)).toEqual([]);
    expect(descriptions()).toEqual(["Couldn't update chapter — try again"]);
  });

  it('does not let an older failed mark undo a newer one on the same chapter', async () => {
    const first = deferred();
    const mark = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const { marking, rows, read } = list({ mark });
    await act(async () => {
      const older = marking.toggleRead(rows[0]); // read: still saving
      await marking.toggleRead(rows[0]); // unread: saved
      await marking.toggleRead(rows[0]); // read again: saved
      first.reject(new Error('the first save failed late'));
      await older;
    });
    // The failed mark would put the chapter back to unread; the newer mark owns it now.
    expect(readIds(read)).toEqual(['c1']);
  });

  it('is refused when the list cannot take a mark', () => {
    const mark = vi.fn(async () => undefined);
    const { marking, rows, read } = list({ begin: () => null, mark });
    expect(marking.toggleRead(rows[0])).toBeUndefined();
    expect(mark).not.toHaveBeenCalled();
    expect(readIds(read)).toEqual([]);
  });

  it('touches nothing once the list has moved to another title or account', async () => {
    const save = deferred();
    const { marking, rows, read, state } = list({ mark: vi.fn(() => save.promise) });
    let saved: boolean | undefined;
    await act(async () => {
      const pending = marking.toggleRead(rows[0]);
      state.current = false;
      read.clear(); // the list now shows something else
      save.reject(new Error());
      saved = await pending;
    });
    expect(saved).toBe(false);
    expect(readIds(read)).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('marking everything up to a chapter', () => {
  it('sends only the chapters that would change, the chapter itself included', async () => {
    const { marking, adapter, rows, read } = list();
    read.add('c2');
    await act(async () => marking.markPrevious(rows[2], true));
    expect(vi.mocked(adapter.markMany).mock.calls[0][0].map((row) => row.id)).toEqual(['c1', 'c3']);
    expect(readIds(read)).toEqual(['c1', 'c2', 'c3']);
    expect(adapter.onManyMarked).toHaveBeenCalledTimes(1);
    expect(toastWithUndo).toHaveBeenCalledWith('Marked 2 chapters as read', expect.any(Function));
  });

  it('says so and saves nothing when there is nothing to change', async () => {
    const { marking, adapter, rows } = list();
    await act(async () => marking.markPrevious(rows[2], false));
    expect(adapter.markMany).not.toHaveBeenCalled();
    expect(descriptions()).toEqual(['Everything up to here is already unread']);
  });

  it('hands the undo exactly the chapters it changed', async () => {
    const { marking, adapter, rows, read } = list();
    read.add('c1');
    await act(async () => marking.markPrevious(rows[1], true));
    const undo = toastWithUndo.mock.calls[0][1] as () => Promise<void>;
    await undo();
    expect(adapter.undoMany).toHaveBeenCalledWith([rows[1]], true, expect.any(Function));
  });

  it('keeps what was saved and puts back what was not when the server applied only part', async () => {
    const { marking, rows, read } = list({
      markMany: vi.fn(async () => ({ count: 2, failed_source_chapter_keys: ['key-c2'] })),
    });
    await act(async () => marking.markPrevious(rows[2], true));
    expect(readIds(read)).toEqual(['c1', 'c3']);
    expect(descriptions()).toEqual(['Updated 2 chapters; 1 failed']);
    // No undo is offered for a result the reader did not get.
    expect(toastWithUndo).not.toHaveBeenCalled();
  });

  it('puts back only its own chapters when the save fails', async () => {
    const bulk = deferred<never>();
    const { marking, rows, read } = list({ markMany: vi.fn(() => bulk.promise) });
    await act(async () => {
      marking.markPrevious(rows[2], true); // c1, c2, c3 shown read, still saving
      await marking.toggleRead(rows[4]); // c5 marked read meanwhile, and saved
      await marking.toggleRead(rows[1]); // c2 flipped back to unread meanwhile, and saved
      bulk.reject(new Error());
      await bulk.promise.catch(() => undefined);
    });
    // c5 was never the bulk mark's to touch, and c2 belongs to the newer mark.
    expect(readIds(read)).toEqual(['c5']);
    expect(descriptions()).toEqual(["Couldn't mark previous chapters — try again"]);
  });

  it('touches nothing once the list has moved on', async () => {
    const bulk = deferred<never>();
    const { marking, rows, read, state } = list({ markMany: vi.fn(() => bulk.promise) });
    await act(async () => {
      marking.markPrevious(rows[2], true);
      state.current = false;
      read.clear();
      read.add('other-title-chapter');
      bulk.reject(new Error());
      await bulk.promise.catch(() => undefined);
    });
    expect(readIds(read)).toEqual(['other-title-chapter']);
    expect(toast).not.toHaveBeenCalled();
  });
});
