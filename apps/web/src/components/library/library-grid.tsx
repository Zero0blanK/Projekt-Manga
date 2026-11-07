'use client';
import { MangaCard } from '@/components/manga-card';
import { MangaGrid } from '@/components/manga-grid';
import { LibraryListRow } from '@/components/library/library-list-row';
import { EmptyState, RowList } from '@/components/page-shell';
import type { Manga } from '@/lib/manga-data';
import { useEffect, useRef, useState } from 'react';
import { LibraryTitleContextMenu } from './library-title-context-menu';
import { useMangaLibrary } from '@/lib/library-store';
import { useDownloadedTitleIds } from '@/components/downloads/row-data';
/** List rows mounted at first, and added each time the end comes into view. */
const CHUNK = 60;

export function LibraryGrid({
  manga,
  view,
  onShowAll,
  selected = [],
  onSelect,
  onContextOpen,
  density = 'comfortable',
  resetKey,
}: {
  manga: Manga[];
  view: 'grid' | 'compact' | 'list';
  onShowAll: () => void;
  selected?: string[];
  onSelect?: (id: string) => void;
  onContextOpen?: () => void;
  density?: 'compact' | 'comfortable' | 'spacious';
  /** Filter/sort/view signature; the list goes back to its first rows only when it
   * changes, not on refetch. */
  resetKey?: string;
}) {
  const { refresh } = useMangaLibrary();
  // The list view reveals rows as you scroll; the cover grid does the same on its own.
  const [revealed, setRevealed] = useState(CHUNK);
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setRevealed(CHUNK);
  }
  const sentinel = useRef<HTMLDivElement | null>(null);
  const more = view === 'list' && revealed < manga.length;
  useEffect(() => {
    const node = sentinel.current;
    if (!more || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setRevealed((current) => current + CHUNK);
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, revealed]);
  const downloaded = useDownloadedTitleIds();
  if (!manga.length)
    return (
      <EmptyState>
        Nothing on this shelf yet.
        <div>
          <button type="button" onClick={onShowAll} className="mt-3 text-xs text-primary">
            Show all titles
          </button>
        </div>
      </EmptyState>
    );
  const selectedIds = new Set(selected);
  const selection = (item: Manga) => ({
    selected: selectedIds.has(item.id),
    selectionMode: selected.length > 0,
    onSelect: onSelect ? () => onSelect(item.id) : undefined,
  });
  return (
    <LibraryTitleContextMenu manga={manga} onOpen={() => onContextOpen?.()} refresh={refresh}>
      <div className="pb-24">
        {view !== 'list' ? (
          <MangaGrid
            className={density === 'compact' ? '!gap-3' : density === 'spacious' ? '!gap-8' : ''}
          >
            {manga.map((item) => (
              <MangaCard
                key={item.id}
                manga={item}
                compact={view === 'compact'}
                downloaded={downloaded.has(item.id)}
                {...selection(item)}
              />
            ))}
          </MangaGrid>
        ) : (
          <RowList>
            {manga.slice(0, revealed).map((item) => (
              <LibraryListRow key={item.id} manga={item} {...selection(item)} />
            ))}
          </RowList>
        )}
        {more && <div ref={sentinel} aria-hidden="true" />}
      </div>
    </LibraryTitleContextMenu>
  );
}
