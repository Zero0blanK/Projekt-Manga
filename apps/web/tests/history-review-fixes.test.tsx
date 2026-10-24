import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { getHistory, deleteHistory } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  deleteHistory: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', () => ({
  getHistory,
  deleteHistory,
  buildImageProxyUrl: (url: string) => url,
}));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: [], loading: false }),
}));
vi.mock('@/lib/report-error', () => ({ reportError: vi.fn() }));

const { HistoryPageClient } = await import('@/app/history/client');
const { RecentsPageClient } = await import('@/app/recents/client');

beforeEach(() => {
  vi.clearAllMocks();
  deleteHistory.mockResolvedValue(undefined);
});

describe('history and recents recovery', () => {
  it('does not mistake a failed Recents request for an empty history', async () => {
    getHistory.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([
      {
        id: 'read-1',
        source: 'source-a',
        manga_slug: 'title',
        title: 'Recovered title',
        chapter_id: 'chapter-1',
        chapter_number: 1,
        last_read: '2026-01-01T12:00:00Z',
        read_at: '2026-01-01T12:00:00Z',
        last_page_read: 2,
        page_count: 10,
      },
    ]);
    render(<RecentsPageClient />);
    expect(await screen.findByText(/Couldn't load recent reading/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing read yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered title')).toBeInTheDocument();
  });

  it('keeps same month and weekday dates from different years in separate groups', async () => {
    getHistory.mockResolvedValueOnce([
      {
        id: 'old',
        manga_id: 'one',
        source: 'source-a',
        manga_slug: 'one',
        title: 'Older title',
        chapter_number: 1,
        read_at: '2020-01-01T12:00:00Z',
        last_read: '2025-01-01T12:00:00Z',
        page_count: 10,
        last_page_read: 5,
        time_read: 1000,
      },
      {
        id: 'new',
        manga_id: 'two',
        source: 'source-a',
        manga_slug: 'two',
        title: 'Newer title',
        chapter_number: 1,
        read_at: '2020-01-01T12:00:00Z',
        last_read: '2031-01-01T12:00:00Z',
        page_count: 10,
        last_page_read: 5,
        time_read: 1000,
      },
    ]);
    render(<HistoryPageClient />);
    expect(await screen.findByText('Older title')).toBeInTheDocument();
    expect(screen.getByText('Wednesday, Jan 1, 2025')).toBeInTheDocument();
    expect(screen.getByText('Wednesday, Jan 1, 2031')).toBeInTheDocument();
  });

  it('restores focus to the clear-history trigger when its confirmation is cancelled', async () => {
    getHistory.mockResolvedValueOnce([
      {
        id: 'read-1',
        source: 'source-a',
        manga_slug: 'title',
        title: 'History title',
        chapter_id: 'chapter-1',
        chapter_number: 1,
        read_at: '2026-01-01T12:00:00Z',
        last_read: '2026-01-01T12:00:00Z',
        last_page_read: 2,
        page_count: 10,
        time_read: 1_000,
      },
    ]);
    const user = userEvent.setup();
    render(<HistoryPageClient />);

    const trigger = await screen.findByRole('button', { name: 'Clear history' });
    await user.click(trigger);
    expect(await screen.findByRole('alertdialog', { name: 'Clear reading history' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
