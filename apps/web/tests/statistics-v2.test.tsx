import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getDownloadStats: vi.fn(),
  session: { user: null as { id: string } | null, loading: false },
}));
vi.mock('@projekt-manga/api-client', () => ({
  getHistory: mocks.getHistory,
  getDownloadStats: mocks.getDownloadStats,
}));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => mocks.session }));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: [], loading: false }),
  useLibraryState: () => ({ shelf: {}, bookmarks: [] }),
}));
import { StatisticsPanel } from '@/components/settings/statistics-panel';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { user: null, loading: false };
  mocks.getHistory.mockResolvedValue([]);
  mocks.getDownloadStats.mockResolvedValue({
    completed: 0,
    totalSize: 0,
    inProgress: 0,
    failed: 0,
  });
});
describe('Reading activity uses actual latest chapter records', () => {
  it('provides a 7/30-day accessible table with exact cumulative pages, read records and distinct source titles', async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const older = new Date(today);
    older.setDate(older.getDate() - 10);
    mocks.getHistory.mockResolvedValue([
      {
        source: 'a',
        manga_slug: 'same',
        last_read: today.toISOString(),
        pages_read: 12,
        is_read: true,
        time_read: 0,
      },
      {
        source: 'a',
        manga_slug: 'same',
        last_read: today.toISOString(),
        pages_read: 5,
        is_read: false,
        time_read: 0,
      },
      {
        source: 'b',
        manga_slug: 'same',
        last_read: today.toISOString(),
        pages_read: 4,
        is_read: true,
        time_read: 0,
      },
      {
        source: 'a',
        manga_slug: 'old',
        last_read: older.toISOString(),
        pages_read: 9,
        is_read: true,
        time_read: 0,
      },
    ]);
    render(<StatisticsPanel />);
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    const todayRow = within(table).getByRole('row', {
      name: `${today.toLocaleDateString()} 21 2 2`,
    });
    expect(
      within(todayRow)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['21', '2', '2']);
    expect(
      screen.getByText(/these bars do not reconstruct daily sessions or reading time/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(within(table).getAllByRole('row')).toHaveLength(31);
    expect(
      within(table).getByRole('row', { name: `${older.toLocaleDateString()} 9 1 1` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears previous profile activity while loading and ignores its late responses', async () => {
    let oldHistory!: (history: unknown[]) => void;
    mocks.getHistory
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldHistory = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    const { rerender } = render(<StatisticsPanel />);
    await waitFor(() => expect(mocks.getHistory).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.getHistory.mock.calls[0][0] as AbortSignal;
    mocks.session.user = { id: 'other' };
    rerender(<StatisticsPanel />);
    expect(oldSignal.aborted).toBe(true);
    await screen.findByRole('table');
    await act(async () =>
      oldHistory([
        {
          source: 'private',
          manga_slug: 'private',
          last_read: new Date().toISOString(),
          pages_read: 999,
          is_read: true,
        },
      ]),
    );
    expect(screen.queryByText('999')).toBeNull();
  });

  it('shows a retryable error instead of fabricated zero statistics', async () => {
    mocks.getHistory.mockRejectedValueOnce(new Error('offline'));
    render(<StatisticsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Statistics are unavailable');
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table');
    expect(mocks.getHistory).toHaveBeenCalledTimes(2);
  });
});
