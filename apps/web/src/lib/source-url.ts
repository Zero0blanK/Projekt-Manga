import { getSourceMangaDetails, getSources } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { copyToClipboard } from '@/lib/clipboard';

/**
 * Resolves a source-supplied URL against the source's base URL, since sources may report
 * chapter links as site-relative paths. Returns null unless the result is an http(s) URL.
 */
export function resolveSourceUrl(
  url: string | null | undefined,
  baseUrl: string | undefined,
): string | null {
  if (!url) return null;
  try {
    const resolved = new URL(url, baseUrl);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
  } catch {
    return null;
  }
}

/** Returns an absolute http(s) URL without embedded credentials, else null. For hrefs and
 * image sources that come from a repository or source rather than from this app. */
export function websiteUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Copies a chapter's address on its source site, never this app's own page address. */
export async function copySourceChapterLink(
  chapter: { url: string; chapterNumber: number },
  sourceId: string,
): Promise<void> {
  let baseUrl: string | undefined;
  try {
    baseUrl = (await getSources()).find((source) => source.id === sourceId)?.base_url;
  } catch {
    // An absolute chapter URL still resolves without the base.
  }
  const url = resolveSourceUrl(chapter.url, baseUrl);
  if (!url) {
    toast({ description: 'No source link available for this chapter' });
    return;
  }
  await copyToClipboard(url, `Copied link to chapter ${chapter.chapterNumber}`);
}

/**
 * Shares a title's page on its source site, falling back to copying the link where the
 * Web Share API is missing or refuses.
 *
 * `knownUrl` is the series URL when the caller already holds the source's details;
 * otherwise (library titles, which store no URL) the source is asked for it.
 */
export async function shareSourceMangaLink(manga: {
  title: string;
  sourceId: string;
  slug: string;
  knownUrl?: string;
}): Promise<void> {
  let url: string | null = null;
  try {
    const [sources, details] = await Promise.all([
      getSources(),
      manga.knownUrl ? null : getSourceMangaDetails(manga.sourceId, manga.slug),
    ]);
    const baseUrl = sources.find((source) => source.id === manga.sourceId)?.base_url;
    url = resolveSourceUrl(manga.knownUrl ?? details?.url, baseUrl);
  } catch {
    // Treated as "no link": the source being unreachable shouldn't be reported as success.
  }
  if (!url) {
    toast({ description: "Couldn't get this title's link from its source" });
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title: manga.title, url });
      return;
    } catch (error) {
      // Dismissing the share sheet isn't a failure. Anything else (e.g. the user gesture
      // expiring during the lookup) falls through to copying.
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  await copyToClipboard(url, 'Link copied to clipboard');
}
