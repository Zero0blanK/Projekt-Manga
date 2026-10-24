import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  sourceChapterPagesSchema,
  sourceMangaDetailsSchema,
  sourceMangaFilterListSchema,
  sourceMangaListSchema,
} from '@projekt-manga/schemas';

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/source-output.json'), 'utf8'),
) as Record<string, unknown>;

describe('source output compatibility fixtures', () => {
  it('accepts a representative search result and image URL', () => {
    const results = sourceMangaListSchema.parse(fixtures.search);

    expect(results[0]).toMatchObject({
      id: 'fixture-manga-001',
      title: 'Fixture Manga',
      thumbnail_url: expect.stringMatching(/^https:\/\//),
    });
  });

  it('accepts manga details and preserves source chapter ordering', () => {
    const details = sourceMangaDetailsSchema.parse(fixtures.details);

    expect(details.chapters.map((chapter) => chapter.chapter_number)).toEqual([2, 1]);
  });

  it('keeps a reported series url and drops a malformed one without rejecting the title', () => {
    const base = fixtures.details as Record<string, unknown>;

    expect(sourceMangaDetailsSchema.parse({ ...base, url: 'https://example.org/m/1' }).url).toBe(
      'https://example.org/m/1',
    );
    expect(sourceMangaDetailsSchema.parse({ ...base, url: 42 }).url).toBeUndefined();
    expect(sourceMangaDetailsSchema.parse(base).url).toBeUndefined();
  });

  it('normalizes numeric page indexes and derives a missing total', () => {
    const pages = sourceChapterPagesSchema.parse(fixtures.pages);

    expect(pages.items.map((page) => page.index)).toEqual([1, 2]);
    expect(pages.items.every((page) => page.image_url?.startsWith('https://'))).toBe(true);
    expect(pages.total).toBe(2);
  });

  it('accepts the supported filter types and options', () => {
    const filters = sourceMangaFilterListSchema.parse(fixtures.filters);

    expect(filters.map((filter) => filter.type)).toEqual(['select', 'tri-state']);
  });
});
