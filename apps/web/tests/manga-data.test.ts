import { describe, it, expect } from 'vitest';
import { fromMangaListItem } from '@/lib/manga-data';
import type { MangaListItem } from '@projekt-manga/api-client';

/**
 * `fromMangaListItem` reads status, genres, description, artist and rating *only* from the
 * nested `manga_detail` object — never from top-level fields. That's easy to miss, and
 * missing it is invisible in a browser: the HTTP endpoints always populate it, so a
 * producer that doesn't (the desktop app's local SQLite bridge did not) looks correct
 * everywhere except in the desktop build, where every card showed a status pill reading
 * "Unknown".
 *
 * These pin the contract from the consumer side, so the requirement is written down
 * somewhere a second producer will find it.
 */

function listItem(patch: Partial<MangaListItem> = {}): MangaListItem {
  return {
    id: 'm-1',
    slug: 'slug-1',
    title: 'Villain Ed',
    author: 'Author',
    source: 'mangadex',
    thumbnail_url: null,
    in_library: true,
    chapter_count: 10,
    unread_count: 4,
    latest_chapter_date: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    manga_detail: {
      status: 'ONGOING',
      genres: 'Action, Romance',
      description: 'A story.',
      artist: 'Green Kyrin',
      rating: null,
    },
    ...patch,
  } as MangaListItem;
}

describe('fromMangaListItem', () => {
  it('reads the status pill out of manga_detail', () => {
    expect(fromMangaListItem(listItem()).status).toBe('Ongoing');
    expect(
      fromMangaListItem(
        listItem({ manga_detail: { ...listItem().manga_detail!, status: 'COMPLETED' } }),
      ).status,
    ).toBe('Completed');
  });

  it('falls back to Unknown when manga_detail is missing entirely', () => {
    // This is the failure the desktop hit: not a wrong status, an absent container.
    expect(fromMangaListItem(listItem({ manga_detail: undefined })).status).toBe('Unknown');
  });

  it('treats an unrecognised status as Unknown rather than rendering it raw', () => {
    const item = listItem({ manga_detail: { ...listItem().manga_detail!, status: 'WEIRD' } });

    expect(fromMangaListItem(item).status).toBe('Unknown');
  });

  it('takes tags, synopsis and artist from manga_detail too', () => {
    const manga = fromMangaListItem(listItem());

    expect(manga.tags).toEqual(['Action', 'Romance']);
    expect(manga.synopsis).toBe('A story.');
    expect(manga.artists).toContain('Green Kyrin');
  });

  it('loses all of those together when manga_detail is absent', () => {
    const manga = fromMangaListItem(listItem({ manga_detail: undefined }));

    // The status pill is just the most visible symptom of the same omission.
    expect(manga.tags).toEqual([]);
    expect(manga.synopsis).toBe('');
    expect(manga.artists).toBeNull();
  });

  it('computes progress from the read/unread split', () => {
    expect(fromMangaListItem(listItem()).progress).toBeCloseTo(0.6);
  });

  it('routes library covers through the cached-thumbnail endpoint', () => {
    const manga = fromMangaListItem(listItem({ thumbnail_url: 'https://example.com/cover.jpg' }));

    expect(manga.thumbnailUrl).toContain('/api/cache/thumbnail/m-1');
    expect(manga.thumbnailUrl).not.toContain('example.com/cover.jpg');
  });

  it('versions cached covers by the stored content hash', () => {
    const first = fromMangaListItem(
      listItem({
        thumbnail_url: 'https://example.com/cover.jpg',
        cache: { sha256_url: 'old-hash' },
      }),
    );
    const refreshed = fromMangaListItem(
      listItem({
        thumbnail_url: 'https://example.com/cover.jpg',
        cache: { sha256_url: 'new-hash' },
      }),
    );
    expect(first.thumbnailUrl).toContain('v=old-hash');
    expect(refreshed.thumbnailUrl).toContain('v=new-hash');
    expect(refreshed.thumbnailUrl).not.toBe(first.thumbnailUrl);
  });
});
