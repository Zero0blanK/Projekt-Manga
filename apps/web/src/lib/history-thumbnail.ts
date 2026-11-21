import { buildApiUrl, buildImageProxyUrl } from '@projekt-manga/api-client';

/**
 * The cover a history row shows.
 *
 * A title the server has a row for is shown through its cover cache: the stored copy, at
 * the size the row needs, once there is one, and the source's cover (stored for next time)
 * until then. Going to the source each time left History's covers blank for seconds while
 * the Library showed the same titles straight away. A title read only from a source has
 * no row, so its cover still comes through the image proxy.
 */
export function historyThumbnailUrl(
  thumbnailUrl: string | null | undefined,
  source: string,
  mangaId: string | null | undefined,
  mangaSlug?: string | null,
): string | null {
  if (!thumbnailUrl) return null;
  if (mangaId) return buildApiUrl(`/cache/thumbnail/${encodeURIComponent(mangaId)}`);
  if (thumbnailUrl.startsWith('/extension/thumbnails/')) {
    return mangaSlug
      ? buildApiUrl(
          `/cache/legacy-thumbnail/${encodeURIComponent(source)}/${encodeURIComponent(mangaSlug)}`,
        )
      : null;
  }
  return /^https?:\/\//i.test(thumbnailUrl) ? buildImageProxyUrl(thumbnailUrl, source) : null;
}
