import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';

const mocks = vi.hoisted(() => ({
  initiateDownload: vi.fn(),
  getAllDownloads: vi.fn(),
  refreshDownloads: vi.fn(),
  session: { user: null as { id: string } | null, loading: false },
}));
vi.mock('@projekt-manga/api-client', () => ({
  initiateDownload: mocks.initiateDownload,
  getAllDownloads: mocks.getAllDownloads,
}));
vi.mock('@/components/downloads/row-data', () => ({ refreshDownloads: mocks.refreshDownloads }));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => mocks.session }));
import { ChapterDownloadPicker } from '@/components/downloads/chapter-download-picker';

const manga = { id: 'title', source: 'source', slug: 'title-slug', title: 'Title' } as Manga;
const chapters = Array.from({ length: 8 }, (_, index) => ({
  id: `chapter-${index + 1}`,
  n: index + 1,
  title: `Chapter ${index + 1}`,
  read: index === 0,
}));
function props() {
  return {
    manga,
    chapters,
    selectedIds: chapters.map((chapter) => chapter.id),
    excludedIds: new Set<string>(),
    available: true,
    onQueued: vi.fn(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { user: null, loading: false };
  mocks.getAllDownloads.mockResolvedValue([]);
  mocks.initiateDownload.mockResolvedValue({});
});

describe('Chapter download admission', () => {
  it('previews an inclusive decimal range and rejects empty or reversed bounds', () => {
    render(
      <ChapterDownloadPicker
        {...props()}
        chapters={[...chapters, { id: 'half', n: 2.5, title: 'Half', read: false }]}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'range' } });
    expect(screen.getByRole('button', { name: 'Queue 0 chapters' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('from'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('to'), { target: { value: '3' } });
    expect(screen.getByRole('button', { name: 'Queue 2 chapters' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('to'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Queue 0 chapters' })).toBeDisabled();
  });

  it('chooses the next five unread in chapter order and excludes known downloads', async () => {
    const nextProps = props();
    render(
      <ChapterDownloadPicker
        {...nextProps}
        chapters={[...chapters].reverse()}
        excludedIds={new Set(['chapter-2'])}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'next' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue 5 chapters' }));
    await screen.findByText('Queued 5 of 5 available chapters.');
    expect(mocks.initiateDownload.mock.calls.map(([payload]) => payload.chapter.id)).toEqual([
      'chapter-3',
      'chapter-4',
      'chapter-5',
      'chapter-6',
      'chapter-7',
    ]);
    expect(nextProps.onQueued).toHaveBeenCalledWith([
      'chapter-3',
      'chapter-4',
      'chapter-5',
      'chapter-6',
      'chapter-7',
    ]);
  });

  it('rechecks status, retains partial failures and retries only unqueued chapters', async () => {
    const nextProps = props();
    nextProps.selectedIds = ['chapter-1', 'chapter-2', 'chapter-3'];
    mocks.getAllDownloads.mockResolvedValueOnce([{ chapter_id: 'chapter-1', status: 'COMPLETED' }]);
    mocks.initiateDownload
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({});
    const { rerender } = render(<ChapterDownloadPicker {...nextProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Queue 3 chapters' }));
    await screen.findByText(/Queued 1 of 2 available chapters.*1 failed/);
    expect(nextProps.onQueued.mock.calls).toEqual([[['chapter-1']], [['chapter-3']]]);
    rerender(
      <ChapterDownloadPicker {...nextProps} excludedIds={new Set(['chapter-1', 'chapter-3'])} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Queue 1 chapters' }));
    await screen.findByText('Queued 1 of 1 available chapters.');
    expect(mocks.initiateDownload.mock.calls.map(([payload]) => payload.chapter.id)).toEqual([
      'chapter-2',
      'chapter-3',
      'chapter-2',
    ]);
  });

  it('does not queue when preflight fails, status is unavailable, or identity is loading', async () => {
    const nextProps = props();
    const { rerender } = render(<ChapterDownloadPicker {...nextProps} available={false} />);
    expect(screen.getByRole('button', { name: 'Queue 8 chapters' })).toBeDisabled();
    mocks.session.loading = true;
    rerender(<ChapterDownloadPicker {...nextProps} />);
    expect(screen.getByRole('button', { name: 'Queue 8 chapters' })).toBeDisabled();
    mocks.session.loading = false;
    rerender(<ChapterDownloadPicker {...nextProps} />);
    mocks.getAllDownloads.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Queue 8 chapters' }));
    await screen.findByText(/No chapters were queued/);
    expect(mocks.initiateDownload).not.toHaveBeenCalled();
  });

  it('stops further requests and ignores late results after a profile switch', async () => {
    const nextProps = props();
    let finish!: () => void;
    mocks.initiateDownload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<ChapterDownloadPicker {...nextProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Queue 8 chapters' }));
    await waitFor(() => expect(mocks.initiateDownload).toHaveBeenCalledTimes(1));
    const signal = mocks.initiateDownload.mock.calls[0][1] as AbortSignal;
    mocks.session.user = { id: 'other-profile' };
    rerender(<ChapterDownloadPicker {...nextProps} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish());
    expect(mocks.initiateDownload).toHaveBeenCalledTimes(1);
    expect(nextProps.onQueued).not.toHaveBeenCalled();
    expect(screen.queryByText(/Queued/)).toBeNull();
  });
});
