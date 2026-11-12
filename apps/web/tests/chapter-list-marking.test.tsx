import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Manga } from '@/lib/manga-data';

// The library chapter list, driven through its own menu: marks made while a bulk mark is
// still saving must survive that bulk mark failing.

const mocks = vi.hoisted(() => ({
  getMangaChapters: vi.fn(),
  getAllDownloads: vi.fn(),
  markChapterAsRead: vi.fn(),
  markChapterAsUnread: vi.fn(),
  markPreviousChaptersAsRead: vi.fn(),
  markPreviousChaptersAsUnread: vi.fn(),
  toast: vi.fn(),
  toastWithUndo: vi.fn(),
}));

vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@projekt-manga/api-client', () => ({
  getMangaChapters: mocks.getMangaChapters,
  getAllDownloads: mocks.getAllDownloads,
  markChapterAsRead: mocks.markChapterAsRead,
  markChapterAsUnread: mocks.markChapterAsUnread,
  markPreviousChaptersAsRead: mocks.markPreviousChaptersAsRead,
  markPreviousChaptersAsUnread: mocks.markPreviousChaptersAsUnread,
  initiateDownload: vi.fn(),
}));
vi.mock('@/lib/manga-updates', () => ({
  useChapterListVersion: () => 0,
  useMangaUpdateCheck: () => ({ checking: false }),
  useCheckOnManualReload: () => undefined,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/undo-toast', () => ({ toastWithUndo: mocks.toastWithUndo }));
vi.mock('@/lib/auto-downloads', () => ({ afterChapterRead: vi.fn(async () => undefined) }));
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

const { ChapterList } = await import('@/components/manga-detail/chapter-list');

const manga = {
  id: 'manga-1',
  slug: 'manga-1',
  title: 'A title',
  source: 'source-a',
  inLibrary: true,
} as Manga;

const record = (n: number) => ({
  id: `chapter-${n}`,
  source_chapter_key: `key-${n}`,
  manga_id: 'manga-1',
  chapter_number: n,
  name: `Chapter ${n}`,
  url: `https://example.com/${n}`,
  is_read: false,
  is_bookmark: false,
  last_page_read: 0,
  page_count: 20,
  release_date: null,
  fetched_at: null,
  created_at: '2026-01-01T00:00:00Z',
  scanlator: null,
});

/** Rows are listed latest first: index 0 is chapter 3. */
const menu = (name: string) => screen.getAllByRole('button', { name });
const readCount = () => screen.queryAllByRole('button', { name: 'Mark as unread' }).length;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMangaChapters.mockResolvedValue([record(1), record(2), record(3)]);
  mocks.getAllDownloads.mockResolvedValue([]);
  mocks.markChapterAsRead.mockResolvedValue({ count: 1 });
});

describe('marking chapters in the library list', () => {
  it('keeps a mark made while a bulk mark was saving, when that bulk mark fails', async () => {
    let failBulk!: (reason: Error) => void;
    mocks.markPreviousChaptersAsRead.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failBulk = reject;
        }),
    );
    render(<ChapterList manga={manga} />);
    await screen.findByRole('link', { name: /Chapter 3/ });

    // Everything up to chapter 2: shown read at once, still saving.
    fireEvent.click(menu('Mark previous as read')[1]);
    await waitFor(() => expect(readCount()).toBe(2));

    // Chapter 3 on its own meanwhile, and that one is saved.
    await act(async () => fireEvent.click(menu('Mark as read')[0]));
    expect(mocks.markChapterAsRead).toHaveBeenCalledWith('manga-1', 'key-3', {
      source: 'source-a',
    });
    expect(readCount()).toBe(3);

    await act(async () => failBulk(new Error('offline')));

    // Chapters 1 and 2 go back; chapter 3 was never the bulk mark's to undo.
    expect(readCount()).toBe(1);
    expect(screen.getAllByRole('button', { name: /Mark as (un)?read/ })[0]).toHaveTextContent(
      'Mark as unread',
    );
    expect(mocks.toast).toHaveBeenCalledWith({
      description: "Couldn't mark previous chapters — try again",
    });
  });

  it('puts back the chapters a bulk mark could not save and offers no undo', async () => {
    mocks.markPreviousChaptersAsRead.mockResolvedValueOnce({
      count: 2,
      failed_source_chapter_keys: ['key-2'],
    });
    render(<ChapterList manga={manga} />);
    await screen.findByRole('link', { name: /Chapter 3/ });

    await act(async () => fireEvent.click(menu('Mark previous as read')[0]));

    expect(readCount()).toBe(2);
    expect(mocks.toast).toHaveBeenCalledWith({ description: 'Updated 2 chapters; 1 failed' });
    expect(mocks.toastWithUndo).not.toHaveBeenCalled();
  });
});
