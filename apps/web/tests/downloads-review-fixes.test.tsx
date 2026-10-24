import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { getAllDownloads } = vi.hoisted(() => ({ getAllDownloads: vi.fn() }));
vi.mock('@projekt-manga/api-client', () => ({
  getAllDownloads,
  subscribeToDownloadEvents: () => () => {},
}));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: [] }),
}));

const { useDownloadRows, useDownloadQueueCount } = await import('@/components/downloads/row-data');

describe('download list recovery', () => {
  it('reports a failed load and excludes failed jobs from the live queue badge', async () => {
    getAllDownloads.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([
      {
        id: 'download-1',
        manga_id: 'manga-1',
        mangaTitle: 'Title',
        chapterNumber: 1,
        status: 'FAILED',
        pages_total: 10,
        pages_downloaded: 2,
        createdAt: '2026-01-01T12:00:00Z',
      },
    ]);

    const { result } = renderHook(() => ({
      rows: useDownloadRows(),
      count: useDownloadQueueCount(),
    }));
    await waitFor(() => expect(result.current.rows.error).toBe(true));
    expect(result.current.rows.active).toHaveLength(0);

    act(() => result.current.rows.refresh());
    await waitFor(() => expect(result.current.rows.active).toHaveLength(1));
    expect(result.current.rows.error).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('surfaces completed records with a missing folder as failed cleanup candidates', async () => {
    getAllDownloads.mockResolvedValueOnce([
      {
        id: 'stale-download',
        manga_id: 'manga-1',
        mangaTitle: 'Title',
        chapterNumber: 1,
        status: 'COMPLETED',
        downloaded_path: '',
        filePath: 'Title/Chapter 1',
        pages_total: 10,
        pages_downloaded: 10,
        createdAt: '2026-01-01T12:00:00Z',
      },
    ]);
    const { result } = renderHook(() => useDownloadRows());
    await waitFor(() => expect(result.current.active).toHaveLength(1));
    expect(result.current.active[0].status).toBe('failed');
    expect(result.current.completed).toHaveLength(0);
  });
});
