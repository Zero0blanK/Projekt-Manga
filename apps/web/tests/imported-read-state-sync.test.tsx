import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  manga: [] as { id: string; slug: string; source: string; chapters: number }[],
  refresh: vi.fn(),
  apply: vi.fn(),
}));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: state.manga, loading: false, refresh: state.refresh }),
}));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@/lib/tachiyomi-backup/extras', () => ({
  applyPendingImportedChapterStates: (...args: unknown[]) => state.apply(...args),
}));

const { ImportedReadStateSync } = await import('@/components/imported-read-state-sync');

const title = (id: string, chapters: number) => ({ id, slug: id, source: 'src', chapters });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('applying imported read state from the library', () => {
  it('refreshes the library once titles were marked', async () => {
    state.manga = [title('a', 3)];
    state.apply.mockResolvedValue(1);
    render(<ImportedReadStateSync />);
    await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
    expect(state.apply).toHaveBeenCalledWith('anonymous', state.manga);
  });

  it('leaves the library alone when nothing was waiting', async () => {
    state.manga = [title('a', 3)];
    state.apply.mockResolvedValue(0);
    render(<ImportedReadStateSync />);
    await waitFor(() => expect(state.apply).toHaveBeenCalled());
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it('runs again on the newer list when it changed during a sweep', async () => {
    let finish: (marked: number) => void = () => undefined;
    state.apply.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    state.apply.mockResolvedValue(1);
    state.manga = [title('a', 0)];
    const view = render(<ImportedReadStateSync />);
    await waitFor(() => expect(state.apply).toHaveBeenCalledTimes(1));

    // A library update synced chapters while the first sweep was still going.
    state.manga = [title('a', 4)];
    view.rerender(<ImportedReadStateSync />);
    expect(state.apply).toHaveBeenCalledTimes(1);
    finish(0);
    await waitFor(() => expect(state.apply).toHaveBeenCalledTimes(2));
    expect(state.apply.mock.calls[1][1]).toEqual([title('a', 4)]);
  });
});
