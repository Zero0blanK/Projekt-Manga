import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Chapters } from '@projekt-manga/types';
const mocks = vi.hoisted(() => ({
  getAllDownloads: vi.fn(),
  markChapterAsRead: vi.fn(),
  addHistory: vi.fn(),
  toast: vi.fn(),
  session: { user: null as { id: string } | null, loading: false },
}));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => mocks.session }));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getAllDownloads: mocks.getAllDownloads,
  markChapterAsRead: mocks.markChapterAsRead,
  addHistory: mocks.addHistory,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/chapter-bookmarks', () => ({
  useChapterBookmarks: () => ({ isBookmarked: () => false, toggle: vi.fn() }),
}));
vi.mock('@/lib/chapter-filter-scroll', () => ({ useChapterFilterScroll: vi.fn() }));
vi.mock('@/components/ui/context-menu', () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    ContextMenu: Wrapper,
    ContextMenuContent: Wrapper,
    ContextMenuTrigger: Wrapper,
    ContextMenuSeparator: () => null,
    ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
      <button onClick={onSelect}>{children}</button>
    ),
  };
});
import { SourceChapterList } from '@/components/manga-detail/source-chapter-list';
import { queryClient, queryKeys } from '@/lib/query-client';
const chapters = [
  { id: 'chapter', chapter_number: 1, name: 'Fixture', url: 'https://example.com/chapter' },
] as Chapters[];
const props = () => ({
  chapters,
  mangaSlug: 'title',
  sourceMangaId: 'native',
  sourceId: 'source',
  mangaTitle: 'Title',
  readChapterIds: new Set<string>(),
  chapterProgress: new Map(),
  readerHref: () => '/read',
  onDownload: vi.fn(),
  onReadChange: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { user: null, loading: false };
  queryClient.clear();
  queryClient.setQueryData(queryKeys.session, null);
  mocks.getAllDownloads.mockResolvedValue([]);
});
afterEach(() => queryClient.clear());
describe('Source chapter profile isolation', () => {
  it('clears downloaded filters and ignores an earlier profile response', async () => {
    let oldResponse!: (downloads: unknown[]) => void;
    mocks.getAllDownloads
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldResponse = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    const { rerender } = render(<SourceChapterList {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Downloaded' }));
    mocks.session.user = { id: 'other' };
    queryClient.setQueryData(queryKeys.session, mocks.session.user);
    await act(async () => rerender(<SourceChapterList {...props()} />));
    await act(async () =>
      oldResponse([
        {
          source_id: 'source',
          chapter_id: 'chapter',
          status: 'COMPLETED',
          downloaded_path: 'managed/chapter',
        },
      ]),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(mocks.getAllDownloads).toHaveBeenCalledTimes(2);
    expect((mocks.getAllDownloads.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
  });
  it('does not create history in the new profile after an old read mark succeeds', async () => {
    let finish!: () => void;
    mocks.markChapterAsRead.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const original = props();
    const { rerender } = render(<SourceChapterList {...original} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
    expect(original.onReadChange).toHaveBeenCalledWith(new Set(['chapter']));
    mocks.session.user = { id: 'other' };
    queryClient.setQueryData(queryKeys.session, mocks.session.user);
    await act(async () => rerender(<SourceChapterList {...props()} />));
    await act(async () => finish());
    expect(mocks.addHistory).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it('does not roll back the current profile when an old mark rejects', async () => {
    let fail!: (error: Error) => void;
    mocks.markChapterAsRead.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const original = props();
    const { rerender } = render(<SourceChapterList {...original} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
    const current = props();
    mocks.session.user = { id: 'other' };
    queryClient.setQueryData(queryKeys.session, mocks.session.user);
    await act(async () => rerender(<SourceChapterList {...current} />));
    await act(async () => fail(new Error('old failure')));
    expect(current.onReadChange).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark as read' })).toBeInTheDocument(),
    );
  });
});
