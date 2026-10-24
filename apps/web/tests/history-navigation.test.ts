import { describe, expect, it } from 'vitest';
import { historyResumeHref, historyTitleHref } from '@/lib/history-navigation';

const sourceRead = {
  source: 'source-a',
  manga_slug: 'a title/with spaces',
  chapter_id: 'chapter/12',
  chapter_number: 0,
  last_page_read: 7,
};

describe('history navigation', () => {
  it('resumes a non-library read by chapter identity and page, not Chapter 0', () => {
    expect(historyResumeHref(sourceRead)).toBe(
      '/discover/preview/source-a/a%20title%2Fwith%20spaces/read?chapterId=chapter%2F12&page=7',
    );
    expect(historyTitleHref(sourceRead)).toBe(
      '/discover/preview/source-a/a%20title%2Fwith%20spaces',
    );
  });

  it('keeps a library title on the library reader', () => {
    const read = { ...sourceRead, manga_id: 'manga-1', chapter_number: 12 };
    expect(historyResumeHref(read)).toBe('/reader/manga-1?ch=12&chapterId=chapter%2F12&page=7');
    expect(historyTitleHref(read)).toBe('/manga/manga-1');
  });

  it('uses the source-native ID when it differs from the catalog slug', () => {
    const read = { ...sourceRead, source_manga_id: 'native/id-42' };
    expect(historyResumeHref(read)).toBe(
      '/discover/preview/source-a/native%2Fid-42/read?chapterId=chapter%2F12&page=7',
    );
  });

  it('uses the source reader for a shadow manga row outside the library', () => {
    const read = { ...sourceRead, manga_id: 'shadow-1', in_library: false };
    expect(historyResumeHref(read)).toBe(
      '/discover/preview/source-a/a%20title%2Fwith%20spaces/read?chapterId=chapter%2F12&page=7',
    );
    expect(historyTitleHref(read)).toBe('/discover/preview/source-a/a%20title%2Fwith%20spaces');
  });

  it('falls back to the source reader when legacy history has no chapter metadata', () => {
    expect(
      historyResumeHref({ ...sourceRead, chapter_id: undefined, chapter_number: undefined }),
    ).toBe('/discover/preview/source-a/a%20title%2Fwith%20spaces/read');
  });
});
