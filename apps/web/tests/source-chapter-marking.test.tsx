import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Chapters } from '@projekt-manga/types';

// The source chapter list, driven through its own menu: a bulk mark the server applied
// only in part must not be reported as a success.

const mocks = vi.hoisted(() => ({
  getAllDownloads: vi.fn(),
  markChapterAsRead: vi.fn(),
  markPreviousChaptersAsRead: vi.fn(),
  addHistory: vi.fn(),
  toast: vi.fn(),
  toastWithUndo: vi.fn(),
}));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getAllDownloads: mocks.getAllDownloads,
  markChapterAsRead: mocks.markChapterAsRead,
  markPreviousChaptersAsRead: mocks.markPreviousChaptersAsRead,
  addHistory: mocks.addHistory,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/undo-toast', () => ({ toastWithUndo: mocks.toastWithUndo }));
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

const chapters = [1, 2, 3].map((n) => ({
  id: `c${n}`,
  chapter_number: n,
  name: `Chapter ${n}`,
  url: `https://example.com/${n}`,
})) as Chapters[];

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

/** Rows are listed latest first: index 0 is chapter 3. */
const menu = (name: string) => screen.getAllByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  queryClient.setQueryData(queryKeys.session, null);
  mocks.getAllDownloads.mockResolvedValue([]);
});
afterEach(() => queryClient.clear());

describe('marking chapters in the source list', () => {
  it('puts back the chapters a bulk mark could not save and offers no undo', async () => {
    mocks.markPreviousChaptersAsRead.mockResolvedValueOnce({
      count: 2,
      failed_source_chapter_keys: ['c2'],
    });
    const given = props();
    render(<SourceChapterList {...given} />);

    await act(async () => fireEvent.click(menu('Mark previous as read')[0]));

    expect(given.onReadChange).toHaveBeenLastCalledWith(new Set(['c1', 'c3']));
    expect(mocks.toast).toHaveBeenCalledWith({ description: 'Updated 2 chapters; 1 failed' });
    expect(mocks.toastWithUndo).not.toHaveBeenCalled();
  });

  it('offers an undo for a bulk mark that was saved whole', async () => {
    mocks.markPreviousChaptersAsRead.mockResolvedValueOnce({
      count: 2,
      failed_source_chapter_keys: [],
    });
    const given = props();
    render(<SourceChapterList {...given} />);

    await act(async () => fireEvent.click(menu('Mark previous as read')[1]));

    expect(given.onReadChange).toHaveBeenLastCalledWith(new Set(['c1', 'c2']));
    expect(mocks.toastWithUndo).toHaveBeenCalledWith(
      'Marked 2 chapters as read',
      expect.any(Function),
    );
  });

  it('keeps a mark made while a bulk mark was saving, when that bulk mark fails', async () => {
    let failBulk!: (reason: Error) => void;
    mocks.markPreviousChaptersAsRead.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failBulk = reject;
        }),
    );
    mocks.markChapterAsRead.mockResolvedValue({ count: 1 });
    mocks.addHistory.mockResolvedValue(undefined);
    const given = props();
    render(<SourceChapterList {...given} />);

    fireEvent.click(menu('Mark previous as read')[1]);
    await act(async () => fireEvent.click(menu('Mark as read')[0]));
    await act(async () => failBulk(new Error('offline')));

    expect(given.onReadChange).toHaveBeenLastCalledWith(new Set(['c3']));
  });
});
