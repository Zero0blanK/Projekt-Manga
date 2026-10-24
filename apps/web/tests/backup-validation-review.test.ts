import { describe, expect, it } from 'vitest';
import { parseBackup } from '@/lib/backup-validation';

const emptyBackup = { version: 2, manga: [], library: [], history: [] };
const title = (id: string, slug = id, chapterId = `${id}-chapter`) => ({
  id,
  source: 'source-a',
  slug,
  title: `Title ${id}`,
  author: 'Author',
  thumbnail_url: 'https://example.test/cover.jpg',
  artist: null,
  description: '',
  genres: '',
  status: 'UNKNOWN',
  rating: null,
  chapters: [
    {
      id: chapterId,
      url: '',
      name: 'Chapter 1',
      chapter_number: 1,
      last_page_read: 0,
      is_read: false,
      is_bookmark: false,
      release_date: null,
      page_count: null,
      scanlator: null,
    },
  ],
});

describe('restore backup validation', () => {
  it('accepts an empty but well-formed backup', () => {
    expect(parseBackup(emptyBackup)).toMatchObject(emptyBackup);
  });

  it('accepts nullable chapter fields from a valid export', () => {
    expect(parseBackup({ ...emptyBackup, manga: [title('m1')] }).manga).toHaveLength(1);
  });

  it('rejects malformed nested entries before restore can mutate data', () => {
    expect(() =>
      parseBackup({ ...emptyBackup, manga: [{ id: 'manga', title: 'Title', chapters: null }] }),
    ).toThrow(/invalid title or chapter/);
    expect(() =>
      parseBackup({ ...emptyBackup, library: [{ manga_id: 'manga', is_bookmarked: 'yes' }] }),
    ).toThrow(/invalid library state/);
    expect(() =>
      parseBackup({ ...emptyBackup, history: [{ source: 'a', manga_slug: 'b', pages_read: -1 }] }),
    ).toThrow(/invalid reading history/);
  });

  it('rejects a dangling library state before merge can write any titles', () => {
    expect(() =>
      parseBackup({
        ...emptyBackup,
        library: [
          {
            manga_id: 'missing',
            is_bookmarked: false,
            notification_read: false,
            shelf_status: null,
          },
        ],
      }),
    ).toThrow(/Library state entry 1 refers to a title/);
  });

  it('identifies duplicate title and chapter entries by their location', () => {
    expect(() => parseBackup({ ...emptyBackup, manga: [title('m1'), title('m2', 'm1')] })).toThrow(
      /duplicate title in entry 2/,
    );
    expect(() =>
      parseBackup({ ...emptyBackup, manga: [title('m1'), title('m2', 'm2', 'm1-chapter')] }),
    ).toThrow(/duplicate chapter in title 2, chapter 1/);
  });

  it('identifies a duplicate library state at the second row', () => {
    const state = {
      manga_id: 'm1',
      is_bookmarked: false,
      notification_read: false,
      shelf_status: null,
    };
    expect(() =>
      parseBackup({
        ...emptyBackup,
        manga: [title('m1')],
        library: [state, state],
      }),
    ).toThrow(/duplicate library state in entry 2/);
  });

  it('identifies invalid chapter data by title and chapter position', () => {
    const invalidTitle = title('m1');
    invalidTitle.chapters[0].chapter_number = 'not-a-number' as unknown as number;
    expect(() => parseBackup({ ...emptyBackup, manga: [invalidTitle] })).toThrow(
      /invalid chapter data in title 1, chapter 1/,
    );

    invalidTitle.chapters[0] = null as unknown as (typeof invalidTitle.chapters)[number];
    expect(() => parseBackup({ ...emptyBackup, manga: [invalidTitle] })).toThrow(
      /invalid chapter data in title 1, chapter 1/,
    );
  });
});
