import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDownloadStats, getOrphanedDownloadFolders, cleanupOrphanedDownloadFolders } = vi.hoisted(
  () => ({
    getDownloadStats: vi.fn(),
    getOrphanedDownloadFolders: vi.fn(),
    cleanupOrphanedDownloadFolders: vi.fn(),
  }),
);
vi.mock('@projekt-manga/api-client', () => ({
  getDownloadStats,
  getOrphanedDownloadFolders,
  cleanupOrphanedDownloadFolders,
}));

const rows = vi.hoisted(() => ({ value: { active: [] as unknown[], completed: [] as unknown[] } }));
vi.mock('@/components/downloads/row-data', () => ({ useDownloadRows: () => rows.value }));

const { StorageStats } = await import('@/components/downloads/storage-stats');

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  getDownloadStats.mockResolvedValue({
    total: 0,
    completed: 0,
    inProgress: 0,
    failed: 0,
    totalSize: 0,
    storageLimit: 10 * 1024 ** 3,
    freeBytes: null,
  });
  getOrphanedDownloadFolders.mockResolvedValue([]);
});

describe('StorageStats', () => {
  it('re-reads the totals when a download finishes', async () => {
    rows.value = { active: [], completed: [] };
    const { rerender } = render(<StorageStats />);
    await waitFor(() => expect(getDownloadStats).toHaveBeenCalledTimes(1));
    rows.value = { active: [], completed: [{ id: 'd1' }] };
    rerender(<StorageStats />);
    await waitFor(() => expect(getDownloadStats).toHaveBeenCalledTimes(2));
  });

  it('warns about low physical disk space and displays the remaining download quota', async () => {
    getDownloadStats.mockResolvedValue({
      total: 5,
      completed: 3,
      inProgress: 1,
      failed: 1,
      totalSize: 2 * 1024 ** 3,
      storageLimit: 10 * 1024 ** 3,
      freeBytes: 512 * 1024 ** 2,
    });
    render(<StorageStats />);
    expect(await screen.findByRole('status')).toHaveTextContent(/less than 1 GB free/i);
    await waitFor(() => expect(screen.getByText('8.0 GB')).toBeTruthy());
  });

  it('does not invent a free-space warning when the filesystem does not report capacity', async () => {
    getDownloadStats.mockResolvedValue({
      total: 0,
      completed: 0,
      inProgress: 0,
      failed: 0,
      totalSize: 0,
      storageLimit: 10 * 1024 ** 3,
      freeBytes: null,
    });
    render(<StorageStats />);
    await screen.findByText('0 B');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('requires confirmation and retains completion feedback after the cleaned folders disappear', async () => {
    const folder = {
      id: 'opaque-folder-id',
      title: 'Example',
      chapterFolder: 'Chapter_1',
      pageCount: 2,
      sizeBytes: 2048,
    };
    getOrphanedDownloadFolders.mockResolvedValueOnce([folder]);
    cleanupOrphanedDownloadFolders.mockResolvedValue({ removed: 1, freedBytes: 2048 });
    render(<StorageStats />);
    const cleanup = await screen.findByRole('button', { name: 'Review and remove 1' });
    fireEvent.click(cleanup);
    expect(await screen.findByText(/Example\/Chapter_1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(cleanupOrphanedDownloadFolders).not.toHaveBeenCalled();
    fireEvent.click(cleanup);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(cleanupOrphanedDownloadFolders).toHaveBeenCalledWith([folder.id]));
    await waitFor(() => expect(getOrphanedDownloadFolders).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('status')).toHaveTextContent('Removed 1 folder');
    expect(screen.queryByRole('button', { name: 'Review and remove 1' })).toBeNull();
  });

  it('keeps storage statistics visible when the orphan scan fails and offers a retry', async () => {
    getOrphanedDownloadFolders.mockRejectedValueOnce(new Error('scan unavailable'));
    render(<StorageStats />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry scan' }));
    await waitFor(() => expect(getOrphanedDownloadFolders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry scan' })).toBeNull());
    expect(screen.getByText('Quota remaining')).toBeInTheDocument();
  });
});
