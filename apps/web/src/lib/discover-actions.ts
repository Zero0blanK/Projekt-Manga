import { getSourceMangaDetails, addManga } from '@projekt-manga/api-client';
import type { Mangas, MangaDetails } from '@projekt-manga/types';
import { getSetting, SHELF_OPTIONS, type ShelfStatus } from '@/lib/app-store';
import { libraryActions } from '@/lib/library-store';

/** Settings > Library > Default shelf. "none" leaves the title unfiled, which is the
 * behaviour when nothing has been chosen. */
function defaultShelf(): ShelfStatus | null {
  const value = String(getSetting('defaultShelf', 'none'));
  return SHELF_OPTIONS.some((o) => o.value === value) ? (value as ShelfStatus) : null;
}

/** Fetches full details for a source catalog item and adds it to the library, returning
 * the new library manga's id (for navigating to its detail page). Pass `known` when the
 * caller already holds the details (the preview page) to skip a redundant scrape. */
export async function addSourceMangaToLibrary(
  sourceId: string,
  item: Mangas,
  known?: MangaDetails,
  /** false creates the row without adding it to the library — used so a preview can
   * download or track chapters (both need a manga_id) without the title showing up as
   * a library entry. */
  inLibrary = true,
): Promise<string> {
  const details = known ?? (await getSourceMangaDetails(sourceId, item.id));
  const created = await addManga({
    in_library: inLibrary,
    source: sourceId,
    title: details.title,
    slug: details.slug,
    author: (details.author ?? []).join(', ') || 'Unknown',
    thumbnail_url: details.thumbnail_url,
    artist: (details.artist ?? []).join(', ') || undefined,
    description: details.description,
    genres: details.genres.join(', '),
    status: details.status,
    chapters: details.chapters,
  });

  // Filing is a library concept, so it only applies to a real library add — not to the
  // shadow rows a preview download/read creates.
  if (inLibrary) {
    const shelf = defaultShelf();
    // Best-effort: the title is already in the library, so a failed filing shouldn't
    // surface as "couldn't add".
    if (shelf) await libraryActions.setShelf(created.id, shelf).catch(() => {});
  }

  return created.id;
}
