import { render, screen } from '@testing-library/react';
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

const { titleShowsNumber } = await import('@/components/manga-detail/chapter-row');
const { SourceChapterList } = await import('@/components/manga-detail/source-chapter-list');

/**
 * A chapter row used to show its number twice: "254" in a badge, then "Chapter 254". The
 * number now appears only when the title doesn't already say it.
 */
describe('chapter number in a row', () => {
  it('counts the title as naming the number only for that exact number', () => {
    expect(titleShowsNumber('Chapter 254', 254)).toBe(true);
    expect(titleShowsNumber('chapter 7', 7)).toBe(true);
    expect(titleShowsNumber('Ch. 12 - The Finale', 12)).toBe(true);
    expect(titleShowsNumber('Vol. 3 Ch.012', 12)).toBe(true);
    expect(titleShowsNumber('Chapter 2.5', 2.5)).toBe(true);

    expect(titleShowsNumber('The Final Battle', 254)).toBe(false);
    expect(titleShowsNumber('Chapter 25', 2)).toBe(false);
    expect(titleShowsNumber('Chapter 2.5', 2)).toBe(false);
    expect(titleShowsNumber('Chapter 2', 2.5)).toBe(false);
    expect(titleShowsNumber('Epoch 4', 4)).toBe(false);
  });

  it('shows the number beside a custom name and drops it from a "Chapter N" title', () => {
    const chapters = [
      { id: 'a', chapter_number: 254, name: 'Chapter 254', url: 'a', release_date: '' },
      { id: 'b', chapter_number: 253, name: 'The Final Battle', url: 'b', release_date: '' },
      { id: 'c', chapter_number: 252, name: '', url: 'c', release_date: '' },
    ] as Chapters[];
    render(
      <SourceChapterList
        chapters={chapters}
        mangaSlug="title"
        sourceMangaId="native"
        sourceId="source"
        mangaTitle="Title"
        readChapterIds={new Set()}
        chapterProgress={new Map()}
        readerHref={(n) => `/reader/x?ch=${n}`}
        onDownload={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const row = (name: RegExp) => screen.getByRole('link', { name });
    // The visible text, in order: title, the details line (phones), then the group and date
    // columns (wide screens); CSS shows one or the other.
    expect(row(/^Chapter 254, /).textContent).toBe(
      'Chapter 254Unknown date · Unknown groupUnknown groupUnknown date',
    );
    expect(row(/^Chapter 253 · The Final Battle/).textContent).toBe(
      'The Final BattleCh. 253 · Unknown date · Unknown groupUnknown groupUnknown date',
    );
    // The accessible names (matched above) keep "Chapter N" either way.
    expect(row(/^Chapter 252, /).textContent).toBe(
      'Chapter 252Unknown date · Unknown groupUnknown groupUnknown date',
    );
  });
});
