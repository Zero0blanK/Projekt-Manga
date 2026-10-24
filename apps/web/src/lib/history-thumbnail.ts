import { buildApiUrl, buildImageProxyUrl } from '@projekt-manga/api-client';

export function historyThumbnailUrl(
  thumbnailUrl: string | null | undefined,
  source: string,
  mangaId: string | null | undefined,
  mangaSlug?: string | null,
): string | null {
  if (!thumbnailUrl) return null;
  if (thumbnailUrl.startsWith('/extension/thumbnails/')) {
    if (mangaId) return buildApiUrl(`/cache/thumbnail/${encodeURIComponent(mangaId)}`);
    return mangaSlug
      ? buildApiUrl(
          `/cache/legacy-thumbnail/${encodeURIComponent(source)}/${encodeURIComponent(mangaSlug)}`,
        )
      : null;
  }
  return /^https?:\/\//i.test(thumbnailUrl) ? buildImageProxyUrl(thumbnailUrl, source) : null;
}
