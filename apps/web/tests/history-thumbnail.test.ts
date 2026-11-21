import { describe, expect, it } from 'vitest';
import { historyThumbnailUrl } from '../src/lib/history-thumbnail';

describe('historyThumbnailUrl', () => {
  it('recovers a legacy public thumbnail through the cache endpoint for a persisted manga', () => {
    expect(
      historyThumbnailUrl('/extension/thumbnails/old.jpg', 'fixture', 'manga/with space'),
    ).toContain('/api/cache/thumbnail/manga%2Fwith%20space');
  });

  it('does not proxy a relative path without an id or slug, and uses a known slug otherwise', () => {
    expect(historyThumbnailUrl('/extension/thumbnails/old.jpg', 'fixture', null)).toBeNull();
    expect(
      historyThumbnailUrl('/extension/thumbnails/old.jpg', 'fixture', null, 'known-slug'),
    ).toContain('/api/cache/legacy-thumbnail/fixture/known-slug');
  });

  it('shows a title the server has a row for through its cover cache', () => {
    expect(historyThumbnailUrl('https://covers.example/a.jpg', 'fixture', 'manga-1')).toContain(
      '/api/cache/thumbnail/manga-1',
    );
  });

  it('proxies an upstream cover for a title read only from a source', () => {
    expect(historyThumbnailUrl('https://covers.example/a.jpg', 'fixture', null)).toContain(
      '/api/source/image-proxy?',
    );
  });
});
