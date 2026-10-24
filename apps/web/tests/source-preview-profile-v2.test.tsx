import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { MangaDetails } from '@projekt-manga/types';
const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  addSourceMangaToLibrary: vi.fn(),
  initiateDownload: vi.fn(),
  session: { user: null as { id: string } | null, loading: false },
}));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => mocks.session }));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getHistory: mocks.getHistory,
  initiateDownload: mocks.initiateDownload,
}));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: [], loading: false, refresh: vi.fn() }),
}));
vi.mock('@/lib/discover-actions', () => ({
  addSourceMangaToLibrary: mocks.addSourceMangaToLibrary,
}));
vi.mock('@/components/discover/duplicate-manga-dialog', () => ({
  useDuplicateCheckedAdd: () => ({ requestAdd: vi.fn(), dialog: null }),
}));
vi.mock('@/components/manga-detail/detail-layout', () => ({
  MangaDetailLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/manga-detail/action-bar', () => ({ MangaActionBar: () => null }));
vi.mock('@/components/manga-detail/source-action-bar', () => ({ SourceActionBar: () => null }));
vi.mock('@/components/manga-detail/similar-titles', () => ({ SimilarTitles: () => null }));
vi.mock('@/components/downloads/row-data', () => ({ refreshDownloads: vi.fn() }));
vi.mock('@/components/manga-detail/source-chapter-list', () => ({
  SourceChapterList: ({
    readChapterIds,
    onDownload,
  }: {
    readChapterIds: Set<string>;
    onDownload: (chapter: unknown) => Promise<unknown>;
  }) => (
    <>
      <span>Read IDs: {[...readChapterIds].join(',') || 'none'}</span>
      <button onClick={() => void onDownload({ id: 'chapter', chapter_number: 1 }).catch(() => {})}>
        Fixture download
      </button>
    </>
  ),
}));
import { SourcePreviewClient } from '@/app/discover/preview/[sourceId]/[mangaId]/client';
import { queryClient, queryKeys } from '@/lib/query-client';
const details = {
  id: 'native',
  slug: 'title',
  title: 'Title',
  chapters: [],
} as unknown as MangaDetails;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { user: null, loading: false };
  queryClient.clear();
  queryClient.setQueryData(queryKeys.session, null);
  mocks.getHistory.mockResolvedValue([]);
});
describe('Source preview profile ownership', () => {
  it('remounts profile progress and ignores late history from a previous profile', async () => {
    let oldHistory!: (history: unknown[]) => void;
    mocks.getHistory
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldHistory = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    const { rerender } = render(<SourcePreviewClient sourceId="source" details={details} />);
    mocks.session.user = { id: 'other' };
    queryClient.setQueryData(queryKeys.session, mocks.session.user);
    await act(async () => rerender(<SourcePreviewClient sourceId="source" details={details} />));
    await act(async () =>
      oldHistory([
        {
          source: 'source',
          manga_slug: 'title',
          chapter_id: 'private',
          last_read: new Date().toISOString(),
          is_read: true,
        },
      ]),
    );
    expect(screen.getByText('Read IDs: none')).toBeInTheDocument();
    expect(mocks.getHistory).toHaveBeenCalledTimes(2);
    expect((mocks.getHistory.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
  });
  it('does not queue a download in a different profile after its old shadow creation completes', async () => {
    let finish!: (id: string) => void;
    mocks.addSourceMangaToLibrary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<SourcePreviewClient sourceId="source" details={details} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fixture download' }));
    await waitFor(() => expect(mocks.addSourceMangaToLibrary).toHaveBeenCalledTimes(1));
    mocks.session.user = { id: 'other' };
    queryClient.setQueryData(queryKeys.session, mocks.session.user);
    await act(async () => rerender(<SourcePreviewClient sourceId="source" details={details} />));
    await act(async () => finish('old-shadow'));
    expect(mocks.initiateDownload).not.toHaveBeenCalled();
  });
});
