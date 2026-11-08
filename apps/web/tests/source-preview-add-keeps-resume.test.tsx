import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { MangaDetails } from '@projekt-manga/types';
import type { Manga } from '@/lib/manga-data';

/**
 * Adding a title to the library from its source page must keep "where I left off".
 *
 * Read part of chapter 1 from the source (history only, no library row), then "Add to
 * Library": the page swaps the source action bar for the library one, which used to be
 * built from the source listing alone. It had no reading position, so "Resume Reading"
 * became "Start Reading" until the page was reloaded.
 */

const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getMangaChapters: vi.fn(),
  onResolved: null as ((id: string) => void) | null,
}));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getHistory: mocks.getHistory,
  getMangaChapters: mocks.getMangaChapters,
}));
// The library list has not caught up with the add yet, as on a real add.
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: [], loading: false, refresh: vi.fn() }),
}));
vi.mock('@/lib/discover-actions', () => ({ addSourceMangaToLibrary: vi.fn() }));
vi.mock('@/components/discover/duplicate-manga-dialog', () => ({
  useDuplicateCheckedAdd: (onResolved: (id: string) => void) => {
    mocks.onResolved = onResolved;
    return {
      requestAdd: async () => {
        onResolved('row-1');
        return 'row-1';
      },
      dialog: null,
    };
  },
}));
vi.mock('@/components/manga-detail/detail-layout', () => ({
  MangaDetailLayout: ({ actions, children }: { actions: ReactNode; children: ReactNode }) => (
    <>
      {actions}
      {children}
    </>
  ),
}));
vi.mock('@/components/manga-detail/action-bar', () => ({
  MangaActionBar: ({ manga }: { manga: Manga }) => (
    <span>
      Library bar:{' '}
      {manga.currentChapter === undefined
        ? 'Start Reading'
        : `Continue Ch. ${manga.currentChapter}`}
      {manga.currentPage ? ` at page ${manga.currentPage}` : ''}
    </span>
  ),
}));
vi.mock('@/components/manga-detail/source-action-bar', () => ({
  SourceActionBar: ({ resuming, onAdd }: { resuming: boolean; onAdd: () => void }) => (
    <>
      <span>Source bar: {resuming ? 'Resume Reading' : 'Start Reading'}</span>
      <button onClick={onAdd}>Add to Library</button>
    </>
  ),
}));
vi.mock('@/components/manga-detail/similar-titles', () => ({ SimilarTitles: () => null }));
vi.mock('@/components/manga-detail/source-chapter-list', () => ({ SourceChapterList: () => null }));
vi.mock('@/components/downloads/row-data', () => ({ refreshDownloads: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { SourcePreviewClient } = await import('@/app/discover/preview/[sourceId]/[mangaId]/client');
const { queryClient, queryKeys } = await import('@/lib/query-client');

const details = {
  id: 'native',
  slug: 'title',
  title: 'Title',
  chapters: [
    { id: 'c1', url: 'https://example.test/1', chapter_number: 1, name: 'Chapter 1' },
    { id: 'c2', url: 'https://example.test/2', chapter_number: 2, name: 'Chapter 2' },
  ],
} as unknown as MangaDetails;

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  queryClient.setQueryData(queryKeys.session, null);
  mocks.getHistory.mockResolvedValue([
    {
      id: 'h1',
      source: 'source',
      manga_slug: 'title',
      source_chapter_key: 'c1',
      chapter_id: null,
      last_page_read: 3,
      page_count: 25,
      is_read: false,
      pages_read: 3,
      time_read: 0,
      last_read: new Date().toISOString(),
      read_at: new Date().toISOString(),
    },
  ]);
  mocks.getMangaChapters.mockResolvedValue([]);
});

describe('adding a source title to the library', () => {
  it('keeps the place reading left off, without a reload', async () => {
    render(<SourcePreviewClient sourceId="source" details={details} />);
    expect(await screen.findByText('Source bar: Resume Reading')).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add to Library' })));

    expect(await screen.findByText('Library bar: Continue Ch. 1 at page 3')).toBeInTheDocument();
  });

  it('still starts at the beginning when nothing was read', async () => {
    mocks.getHistory.mockResolvedValue([]);
    render(<SourcePreviewClient sourceId="source" details={details} />);
    expect(await screen.findByText('Source bar: Start Reading')).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add to Library' })));

    expect(await screen.findByText('Library bar: Start Reading')).toBeInTheDocument();
  });
});
