import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Chapters } from '@projekt-manga/types';
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getAllDownloads: vi.fn().mockResolvedValue([
    {
      source_id: 'source',
      chapter_id: 'chapter-1',
      status: 'COMPLETED',
      downloaded_path: 'managed/chapter-1',
    },
    { source_id: 'source', chapter_id: 'chapter-2', status: 'FAILED', downloaded_path: '' },
  ]),
}));
vi.mock('@/lib/chapter-bookmarks', () => ({
  useChapterBookmarks: () => ({
    isBookmarked: (id: string) => id === 'chapter-3',
    toggle: vi.fn(),
  }),
}));
vi.mock('@/lib/chapter-filter-scroll', () => ({ useChapterFilterScroll: vi.fn() }));
import { SourceChapterList } from '@/components/manga-detail/source-chapter-list';
const chapters = Array.from({ length: 250 }, (_, index) => ({
  id: `chapter-${index + 1}`,
  chapter_number: index + 1,
  name: `Release ${index + 1}`,
  url: `https://example.com/${index + 1}`,
  release_date: '',
})) as Chapters[];
function List() {
  return (
    <SourceChapterList
      chapters={chapters}
      mangaSlug="title"
      sourceMangaId="native"
      sourceId="source"
      mangaTitle="Title"
      readChapterIds={new Set(['chapter-1'])}
      chapterProgress={new Map()}
      readerHref={(number) => `/read?ch=${number}`}
      onDownload={vi.fn()}
    />
  );
}
describe('Source chapter filters', () => {
  it('bounds mounted rows and clears search without a reset filters action', async () => {
    await act(async () => {
      render(<List />);
    });
    expect(screen.getAllByRole('link').length).toBeLessThan(250);
    expect(screen.queryByRole('button', { name: 'Reset chapter filters' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find a chapter' }), {
      target: { value: 'Release 250' },
    });
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/read?ch=250&chapterId=chapter-250');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('textbox', { name: 'Find a chapter' })).toHaveValue('');
    expect(screen.getAllByRole('link').length).toBeGreaterThan(1);
    expect(screen.queryByRole('button', { name: 'Reset chapter filters' })).not.toBeInTheDocument();
  });
  it('combines read, actual downloaded and bookmark filters without treating failed jobs as downloads', async () => {
    await act(async () => {
      render(<List />);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Downloaded' }));
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveTextContent('Release 1');
    fireEvent.click(screen.getByRole('button', { name: 'Bookmarked' }));
    expect(screen.getByRole('link')).toHaveTextContent('Release 3');
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(screen.getByRole('link')).toHaveTextContent('Release 1');
    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
    expect(screen.getByText('249 of 250')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Release 1$/ })).not.toBeInTheDocument();
  });
});
