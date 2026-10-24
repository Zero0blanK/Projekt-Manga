import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

const { getHistory, deleteHistory, toast } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  deleteHistory: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', () => ({
  getHistory,
  deleteHistory,
  buildImageProxyUrl: (url: string) => url,
}));
vi.mock('@/hooks/use-toast', () => ({ toast }));

const { HistoryPageClient } = await import('@/app/history/client');

const historyRow = {
  id: 'chapter-1',
  manga_id: 'manga-1',
  manga_slug: 'manga-1',
  source: 'source-a',
  title: 'Sample title',
  thumbnail_url: null,
  chapter_number: 1,
  name: 'First chapter',
  read_at: '2026-01-01T12:00:00Z',
  page_count: 10,
  last_page_read: 5,
  time_read: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  getHistory.mockResolvedValue([historyRow]);
  deleteHistory.mockResolvedValue(undefined);
});

describe('History page', () => {
  it('shows a retry action after a failed read and recovers when retried', async () => {
    getHistory.mockRejectedValueOnce(new Error('offline'));
    render(<HistoryPageClient />);

    expect(await screen.findByText("Couldn't load your reading history.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing read yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Sample title')).toBeInTheDocument();
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it('allows Undo from the persistent toast after navigating away', async () => {
    const view = render(<HistoryPageClient />);
    await screen.findByText('Sample title');
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Remove from history' }));

      const action = toast.mock.calls.at(-1)?.[0]?.action as ReactElement<{ onClick: () => void }>;
      expect(action).toBeDefined();
      view.unmount();
      act(() => action.props.onClick());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(deleteHistory).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
