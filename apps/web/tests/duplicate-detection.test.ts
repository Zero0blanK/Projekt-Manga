import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  titleSimilarity,
  findLibraryDuplicates,
  DUPLICATE_THRESHOLD,
} from '@/lib/duplicate-detection';
import type { Manga } from '@/lib/manga-data';

function manga(partial: Partial<Manga> & { id: string; title: string }): Manga {
  return {
    slug: partial.id,
    source: 'mangadex',
    author: '',
    artist: '',
    status: 'ongoing',
    genres: [],
    chapters: 0,
    unread: 0,
    progress: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    color: '',
    accent: '',
    synopsis: '',
    rating: null,
    thumbnailUrl: null,
    inLibrary: true,
    ...partial,
  } as Manga;
}

describe('normalizeTitle', () => {
  it('strips the decoration sources bolt onto the same series', () => {
    expect(normalizeTitle('Rent-A-Girlfriend')).toBe(normalizeTitle('Rent a Girlfriend'));
    expect(normalizeTitle('Solo Leveling (Official)')).toBe(normalizeTitle('Solo Leveling'));
    expect(normalizeTitle('Berserk [Colored]')).toBe(normalizeTitle('Berserk'));
    expect(normalizeTitle('One Piece - Digital Colored')).toBe(normalizeTitle('One Piece'));
  });

  it('ignores diacritics and case', () => {
    expect(normalizeTitle('Pokémon Adventures')).toBe(normalizeTitle('pokemon adventures'));
  });

  it('keeps non-Latin scripts intact rather than stripping them to nothing', () => {
    // Stripping non-ASCII would collapse every CJK title to '', which would then make
    // all of them exact matches for each other.
    expect(normalizeTitle('鋼の錬金術師')).toBe('鋼の錬金術師');
    expect(normalizeTitle('나 혼자만 레벨업')).not.toBe('');
  });

  it('does not merge two genuinely different titles into one', () => {
    expect(normalizeTitle('Naruto')).not.toBe(normalizeTitle('Bleach'));
  });
});

describe('titleSimilarity', () => {
  it('scores an identical string as 1', () => {
    expect(titleSimilarity('one piece', 'one piece')).toBe(1);
  });

  it('scores unrelated titles far below the threshold', () => {
    expect(titleSimilarity('naruto', 'berserk')).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it('is unfazed by an extra trailing word', () => {
    expect(titleSimilarity('solo leveling', 'solo leveling manhwa')).toBeGreaterThan(0.7);
  });
});

describe('findLibraryDuplicates', () => {
  const library = [
    manga({ id: 'lib-1', title: 'Rent-A-Girlfriend', source: 'mangadex', slug: 'rent-a-gf' }),
    manga({ id: 'lib-2', title: 'Berserk', source: 'mangadex', slug: 'berserk' }),
  ];

  it('matches the same series titled differently by another source', () => {
    const matches = findLibraryDuplicates('Rent a Girlfriend (Official)', library);

    expect(matches).toHaveLength(1);
    expect(matches[0].manga.id).toBe('lib-1');
    expect(matches[0].exact).toBe(true);
  });

  it('returns nothing for a title that is genuinely new', () => {
    expect(findLibraryDuplicates('Vinland Saga', library)).toEqual([]);
  });

  it('skips the entry being re-visited from the source it was added from', () => {
    // Same source and slug is the entry itself, not a duplicate of it.
    const matches = findLibraryDuplicates('Berserk', library, {
      excludeSource: 'mangadex',
      excludeSlug: 'berserk',
    });

    expect(matches).toEqual([]);
  });

  it('still flags the same title coming from a different source', () => {
    const matches = findLibraryDuplicates('Berserk', library, {
      excludeSource: 'kissmanga',
      excludeSlug: 'berserk',
    });

    expect(matches.map((m) => m.manga.id)).toEqual(['lib-2']);
  });

  it('ignores rows that are not actually in the library', () => {
    // A shadow row exists so a preview download had a manga_id to attach to — it is not
    // a library entry and must not be offered as a duplicate.
    const withShadow = [manga({ id: 'shadow', title: 'Berserk', inLibrary: false })];

    expect(findLibraryDuplicates('Berserk', withShadow)).toEqual([]);
  });

  it('orders several matches with the closest first', () => {
    const many = [
      manga({ id: 'near', title: 'Attack on Titan: Before the Fall', slug: 'aot-botf' }),
      manga({ id: 'exact', title: 'Attack on Titan', slug: 'aot' }),
    ];

    const matches = findLibraryDuplicates('Attack on Titan', many);

    expect(matches[0].manga.id).toBe('exact');
    expect(matches[0].score).toBeGreaterThanOrEqual(matches[matches.length - 1].score);
  });

  it('returns nothing for a title that normalises away entirely', () => {
    expect(findLibraryDuplicates('---', library)).toEqual([]);
  });
});
