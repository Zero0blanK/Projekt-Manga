import { describe, expect, it } from 'vitest';
import {
  NO_LIBRARY_FILTERS,
  cycleTag,
  libraryTags,
  parseLibraryFilters,
  passesLibraryFilters,
} from '@/lib/library-filters';

const title = { status: 'Ongoing' as const, tags: ['Action', 'Romance'] };

describe('passesLibraryFilters', () => {
  it('passes everything with no filters', () => {
    expect(passesLibraryFilters(title, NO_LIBRARY_FILTERS)).toBe(true);
  });

  it('matches any chosen status', () => {
    const filters = { ...NO_LIBRARY_FILTERS, statuses: ['Ongoing', 'Hiatus'] as const };
    expect(passesLibraryFilters(title, { ...filters, statuses: [...filters.statuses] })).toBe(true);
    expect(passesLibraryFilters(title, { ...NO_LIBRARY_FILTERS, statuses: ['Completed'] })).toBe(
      false,
    );
  });

  it('needs every required tag and no excluded one, whatever the case', () => {
    expect(
      passesLibraryFilters(title, { ...NO_LIBRARY_FILTERS, includeTags: ['action', 'ROMANCE'] }),
    ).toBe(true);
    expect(passesLibraryFilters(title, { ...NO_LIBRARY_FILTERS, includeTags: ['Horror'] })).toBe(
      false,
    );
    expect(passesLibraryFilters(title, { ...NO_LIBRARY_FILTERS, excludeTags: ['romance'] })).toBe(
      false,
    );
  });
});

describe('cycleTag', () => {
  it('goes from off to required to excluded to off', () => {
    const required = cycleTag(NO_LIBRARY_FILTERS, 'Action');
    expect(required.includeTags).toEqual(['Action']);
    const excluded = cycleTag(required, 'Action');
    expect(excluded).toMatchObject({ includeTags: [], excludeTags: ['Action'] });
    expect(cycleTag(excluded, 'Action')).toEqual(NO_LIBRARY_FILTERS);
  });
});

describe('libraryTags', () => {
  it('lists each tag once, most used first', () => {
    expect(libraryTags([{ tags: ['Action'] }, { tags: ['action', 'Drama'] }])).toEqual([
      'Action',
      'Drama',
    ]);
  });
});

describe('parseLibraryFilters', () => {
  it('keeps only what it recognises', () => {
    expect(parseLibraryFilters({ statuses: ['Ongoing', 'Nonsense', 3], includeTags: 'x' })).toEqual(
      { statuses: ['Ongoing'], includeTags: [], excludeTags: [] },
    );
    expect(parseLibraryFilters(null)).toEqual(NO_LIBRARY_FILTERS);
  });
});
