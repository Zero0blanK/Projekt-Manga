import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MangaFilter } from '@projekt-manga/types';
import { genreFilterValues } from '@/lib/filter-values';
import { GenrePills, genreHref } from '@/components/manga-detail/manga-info';

const filters: MangaFilter[] = [
  {
    label: 'Order by',
    value: 'sortBy',
    type: 'select',
    options: [{ label: 'Action', value: 'weird-sort' }],
  },
  {
    label: 'Genres',
    value: 'genre',
    type: 'tri-state',
    options: [
      { label: 'Action', value: '391b0423' },
      { label: 'Slice of Life', value: 'slice' },
    ],
  },
];

describe('genre pills', () => {
  it("selects the genre in the source's own genre filter", () => {
    expect(genreFilterValues(filters, 'action')).toEqual({ genre: { include: ['391b0423'] } });
    expect(genreFilterValues(filters, 'Slice-of-life')).toEqual({
      genre: { include: ['slice'] },
    });
  });

  it('uses the shape each kind of field takes, and never a sort that shares the name', () => {
    const multi: MangaFilter[] = [
      { label: 'Tags', value: 'tags', type: 'multi', options: [{ label: 'Murim', value: 'm' }] },
    ];
    expect(genreFilterValues(multi, 'Murim')).toEqual({ tags: ['m'] });
    expect(genreFilterValues([filters[0]], 'Action')).toBeNull();
    expect(genreFilterValues(filters, 'Reincarnation')).toBeNull();
  });

  it("links each pill to its source's titles in that genre", () => {
    render(<GenrePills tags={['Action', 'Slice of Life']} source="asura" />);
    expect(screen.getByRole('link', { name: 'Slice of Life' }).getAttribute('href')).toBe(
      genreHref('asura', 'Slice of Life'),
    );
    expect(genreHref('asura', 'Slice of Life')).toBe(
      '/discover/popular?source=asura&genre=Slice+of+Life',
    );
  });

  it('shows plain pills when the title has no source', () => {
    render(<GenrePills tags={['Action']} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Action')).toBeTruthy();
  });
});
