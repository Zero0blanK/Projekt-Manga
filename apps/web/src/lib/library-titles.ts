'use client';

import { useMemo } from 'react';
import type { Mangas } from '@projekt-manga/types';
import { useSetting } from '@/lib/app-store';
import { useMangaLibrary } from '@/lib/library-store';
import type { Manga } from '@/lib/manga-data';

/** Settings key: hide source results that are already in the library. Off by default. */
export const HIDE_LIBRARY_IN_SOURCES = 'hideLibraryInSources';

/**
 * Whether a source result is a title already in the library. Sources identify a title by
 * the same value that becomes its slug, which is what the library stores.
 */
export function isInLibrary(
  library: ReadonlyArray<Pick<Manga, 'source' | 'slug' | 'inLibrary'>>,
  sourceId: string,
  item: Pick<Mangas, 'id' | 'slug'>,
): boolean {
  return library.some(
    (m) => m.source === sourceId && m.inLibrary && (m.slug === item.slug || m.slug === item.id),
  );
}

/**
 * The source results to show, without library titles when the reader turned that on.
 * `hidden` counts what was left out, so a list emptied by the setting can say so instead
 * of reading as "no results".
 */
export function useVisibleSourceResults<T extends Mangas>(items: T[], sourceId?: string) {
  const hide = useSetting(HIDE_LIBRARY_IN_SOURCES, false) as boolean;
  const { manga: library } = useMangaLibrary();
  return useMemo(() => {
    if (!hide || library.length === 0) return { visible: items, hidden: 0 };
    const visible = items.filter((item) => !isInLibrary(library, sourceId ?? item.source, item));
    return { visible, hidden: items.length - visible.length };
  }, [hide, library, items, sourceId]);
}
