import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Chapters } from '@projekt-manga/types';

vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getAllDownloads: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/chapter-bookmarks', () => ({
  useChapterBookmarks: () => ({ isBookmarked: () => false, toggle: vi.fn() }),
}));
vi.mock('@/lib/chapter-filter-scroll', () => ({ useChapterFilterScroll: vi.fn() }));

const { SourceChapterList } = await import('@/components/manga-detail/source-chapter-list');

const chapters = [
  { id: 'c1', chapter_number: 1, name: 'One', url: 'u1', release_date: '', scanlator: 'Alpha' },
  { id: 'c2', chapter_number: 2, name: 'Two', url: 'u2', release_date: '', scanlator: 'Beta' },
  { id: 'c3', chapter_number: 3, name: 'Three', url: 'u3', release_date: '', scanlator: 'Alpha' },
] as Chapters[];

function List({ list = chapters }: { list?: Chapters[] } = {}) {
  return (
    <SourceChapterList
      chapters={list}
      mangaSlug="title"
      sourceMangaId="native"
      sourceId="source"
      mangaTitle="Title"
      readChapterIds={new Set()}
      chapterProgress={new Map()}
      readerHref={(n) => `/reader/x?ch=${n}`}
      onDownload={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

/**
 * A title has two chapter lists, one from the library and one from its source, and their
 * toolbars must stay consistent (scanlation-group filter, labelled sort control). Assertions
 * use accessible names rather than classes, so restyling is free but losing a control or
 * its label is not.
 */
describe('source chapter toolbar', () => {
  it('offers the same filters as the library list, group filter included', async () => {
    render(<List />);

    for (const name of ['All', 'Unread', 'Read', 'Downloaded', 'Bookmarked']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /All groups/ })).toBeInTheDocument();
  });

  it('labels the sort control instead of leaving it an unlabelled icon', async () => {
    const user = userEvent.setup();
    render(<List />);

    // Named by its visible text so voice control ("click Latest first") works; an
    // aria-label contradicting the visible text would break that.
    const sort = screen.getByRole('button', { name: 'Latest first' });
    expect(sort).toHaveAttribute('title', 'Switch to oldest first');

    await user.click(sort);

    expect(screen.getByRole('button', { name: 'Oldest first' })).toBeInTheDocument();
  });

  it('narrows the list to one scanlation group', async () => {
    const user = userEvent.setup();
    render(<List />);

    await user.click(screen.getByRole('button', { name: /All groups/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Beta' }));

    // By accessible name: the row's visible text is split across elements, and the link
    // is what a reader actually targets.
    const list = screen.getByRole('list', { name: 'Chapters' });
    const rows = within(list)
      .getAllByRole('link')
      .map((link) => link.getAttribute('aria-label') ?? '');
    expect(rows.some((label) => label.includes('Chapter 2'))).toBe(true);
    expect(rows.some((label) => label.includes('Chapter 1'))).toBe(false);
    expect(rows.some((label) => label.includes('Chapter 3'))).toBe(false);
  });

  it('hides the group filter when there is no choice to make', () => {
    render(<List list={[chapters[0]]} />);

    expect(screen.queryByRole('button', { name: /All groups/ })).toBeNull();
  });
});
