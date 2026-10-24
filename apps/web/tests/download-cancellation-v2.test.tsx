import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadRow } from '@/components/downloads/row-data';
const mocks = vi.hoisted(() => ({
  cancelDownload: vi.fn(),
  session: { user: null as { id: string } | null, loading: false },
}));
vi.mock('@projekt-manga/api-client', () => ({ cancelDownload: mocks.cancelDownload }));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => mocks.session }));
vi.mock('@/components/downloads/actions', () => ({
  togglePauseDownload: vi.fn(),
  removeDownload: vi.fn(),
  removeFailedDownloads: vi.fn(),
}));
vi.mock('@/components/downloads/download-cover', () => ({ DownloadCover: () => null }));
import { ActiveDownloadsList } from '@/components/downloads/active-downloads-list';
const rows = [1, 2, 3].map((index) => ({
  id: `job-${index}`,
  mangaId: 'manga',
  title: 'Title',
  chapters: `Chapter ${index}`,
  chapterNumber: index,
  status: 'queued',
  progress: 0,
  pages: '0 / 10 pages',
  addedAt: new Date().toISOString(),
})) as DownloadRow[];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { user: null, loading: false };
  mocks.cancelDownload.mockResolvedValue({});
});
const acceptCancel = async () =>
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel downloads' }));
describe('Confirmed batch download cancellation', () => {
  it('requires confirmation and keeps only failed jobs selected for retry', async () => {
    const onChange = vi.fn();
    render(<ActiveDownloadsList rows={rows} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all active' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selected (3)' }));
    expect(await screen.findByText(/remove their partial files/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.cancelDownload).not.toHaveBeenCalled();
    mocks.cancelDownload
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selected (3)' }));
    await acceptCancel();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Cancelled 2 of 3 downloads. Failed jobs remain selected for retry.',
    );
    expect(screen.getByRole('button', { name: 'Cancel selected (1)' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selected (1)' }));
    await acceptCancel();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(mocks.cancelDownload.mock.calls.map(([id]) => id)).toEqual([
      'job-1',
      'job-2',
      'job-3',
      'job-2',
    ]);
  });
  it('stops subsequent cancellation and clears selection when the active profile changes', async () => {
    let finish!: () => void;
    mocks.cancelDownload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onChange = vi.fn();
    const { rerender } = render(<ActiveDownloadsList rows={rows} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all active' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selected (3)' }));
    await acceptCancel();
    await waitFor(() => expect(mocks.cancelDownload).toHaveBeenCalledTimes(1));
    mocks.session.user = { id: 'other-profile' };
    rerender(<ActiveDownloadsList rows={rows} onChange={onChange} />);
    await act(async () => finish());
    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel selected (0)' })).toBeDisabled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
