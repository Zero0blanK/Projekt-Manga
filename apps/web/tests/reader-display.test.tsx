import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { adjacentChapter, adjacentRelease, releaseStops } from '@/lib/chapter-skip';
import { knownGroup } from '@/lib/manga-data';
import { parseChapterFilter, releasePassesFilter } from '@/lib/chapter-filter';
import { isTallPage, readerTintColor, tintBlendMode } from '@/lib/page-image';
import type { Manga } from '@/lib/manga-data';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { MangaCard } from '@/components/manga-card';

describe('skipping read chapters', () => {
  const sorted = [1, 2, 3, 4, 5];
  const read = new Set([2, 3]);
  const skip = (n: number) => read.has(n);

  it('passes over read chapters in either direction', () => {
    expect(adjacentChapter(sorted, 1, 1, skip)).toBe(4);
    expect(adjacentChapter(sorted, 4, -1, skip)).toBe(1);
    expect(adjacentChapter(sorted, 1, 1)).toBe(2);
  });

  it('falls back to the next chapter when everything that way is read', () => {
    expect(adjacentChapter([1, 2, 3], 1, 1, () => true)).toBe(2);
    expect(adjacentChapter(sorted, 5, 1, skip)).toBeNull();
    expect(adjacentChapter(sorted, 1, -1, skip)).toBeNull();
  });
});

describe('duplicate chapters', () => {
  const releases = [
    { id: 'a12', chapter_number: 12, scanlator: 'Alpha', is_read: false },
    { id: 'a12-reupload', chapter_number: 12, scanlator: 'alpha ', is_read: false },
    { id: 'b12', chapter_number: 12, scanlator: 'Beta', is_read: true },
    { id: 'a13', chapter_number: 13, scanlator: 'Alpha', is_read: false },
    { id: 'b11', chapter_number: 11, scanlator: 'Beta', is_read: false },
  ];

  it("gives each group's release of a chapter one stop, and a group's own repeat none", () => {
    expect(releaseStops(releases).map((r) => r.id)).toEqual(['b11', 'a12', 'b12', 'a13']);
    // The preferred group's release comes first among a chapter's releases.
    expect(releaseStops(releases, 'Beta').map((r) => r.id)).toEqual(['b11', 'b12', 'a12', 'a13']);
    // The release being read stands for its group even when it is the repeat.
    expect(releaseStops(releases, '', 'a12-reupload').map((r) => r.id)).toContain('a12-reupload');
  });

  it('steps between releases, passing over skipped ones', () => {
    const stops = releaseStops(releases);
    expect(adjacentRelease(stops, releases[0], 1)?.id).toBe('b12');
    expect(adjacentRelease(stops, releases[0], 1, (r) => r.is_read)?.id).toBe('a13');
    expect(adjacentRelease(stops, releases[1], -1)?.id).toBe('b11');
    expect(adjacentRelease(stops, releases[3], 1)).toBeNull();
  });
});

describe('chapter-list filters in the reader', () => {
  const context = { downloaded: new Set(['dl']), isBookmarked: (key: string) => key === 'bm' };
  const release = (overrides = {}) => ({
    id: 'x',
    source_chapter_key: 'x',
    is_read: false,
    scanlator: 'Alpha',
    ...overrides,
  });

  it('reads a stored filter strictly', () => {
    expect(parseChapterFilter({ status: 'Unread', group: 'Alpha' })).toEqual({
      status: 'Unread',
      group: 'Alpha',
      hiddenGroups: [],
    });
    expect(parseChapterFilter({ status: 'Everything', group: 42 })).toEqual({
      status: 'All',
      group: 'All',
      hiddenGroups: [],
    });
    expect(parseChapterFilter(null)).toEqual({ status: 'All', group: 'All', hiddenGroups: [] });
  });

  it('hides a release from a hidden group', () => {
    expect(
      releasePassesFilter(
        release(),
        { status: 'All', group: 'All', hiddenGroups: [knownGroup(release().scanlator)] },
        context,
      ),
    ).toBe(false);
  });

  it('decides each release the way the chapter list does', () => {
    expect(
      releasePassesFilter(release(), { status: 'Unread', group: 'All', hiddenGroups: [] }, context),
    ).toBe(true);
    expect(
      releasePassesFilter(
        release({ is_read: true }),
        { status: 'Unread', group: 'All', hiddenGroups: [] },
        context,
      ),
    ).toBe(false);
    expect(
      releasePassesFilter(release(), { status: 'All', group: 'Beta', hiddenGroups: [] }, context),
    ).toBe(false);
    expect(
      releasePassesFilter(
        release({ id: 'dl' }),
        { status: 'Downloaded', group: 'All', hiddenGroups: [] },
        context,
      ),
    ).toBe(true);
    expect(
      releasePassesFilter(
        release({ source_chapter_key: 'bm' }),
        { status: 'Bookmarked', group: 'All', hiddenGroups: [] },
        context,
      ),
    ).toBe(true);
  });
});

describe('reader display helpers', () => {
  it('uses a custom tint only when it is a real colour', () => {
    expect(readerTintColor('Custom', '#112233')).toBe('#112233');
    expect(readerTintColor('Custom', 'red; background: url(x)')).toBeUndefined();
    expect(readerTintColor('Custom')).toBeUndefined();
    expect(readerTintColor('Amber', '#112233')).not.toBe('#112233');
  });

  it('maps blend settings and spots webtoon pages', () => {
    expect(tintBlendMode('Screen')).toBe('screen');
    expect(tintBlendMode('Overlay')).toBe('overlay');
    expect(tintBlendMode('bogus')).toBe('multiply');
    expect(isTallPage(800, 4000)).toBe(true);
    expect(isTallPage(800, 1200)).toBe(false);
  });
});

const manga = (overrides: Partial<Manga> = {}) =>
  ({
    id: 'title-1',
    title: 'Frieren',
    author: 'Yamada',
    source: 'source-a',
    tags: [],
    ...overrides,
  }) as unknown as Manga;

describe('continue reading from the library cover', () => {
  it('opens the reader at the chapter and page in progress', () => {
    render(<MangaCard manga={manga({ currentChapter: 12, currentPage: 4 })} />);
    fireEvent.click(screen.getByText(/Continue · Ch 12/));
    expect(push).toHaveBeenCalledWith('/reader/title-1?ch=12&page=4');
  });

  it('offers nothing to continue on a title not started', () => {
    render(<MangaCard manga={manga()} />);
    expect(screen.queryByText(/Continue/)).toBeNull();
    expect(screen.getByText('Read')).toBeInTheDocument();
  });
});
