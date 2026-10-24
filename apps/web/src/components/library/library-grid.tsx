'use client';
import { MangaCard } from '@/components/manga-card';
import { MangaGrid } from '@/components/manga-grid';
import { LibraryListRow } from '@/components/library/library-list-row';
import { EmptyState, RowList } from '@/components/page-shell';
import type { Manga } from '@/lib/manga-data';
import { useState } from 'react';
import { LibraryTitleContextMenu } from './library-title-context-menu';
import { useMangaLibrary } from '@/lib/library-store';
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
  view: 'grid' | 'list';
  onShowAll: () => void;
  selected?: string[];
  onSelect?: (id: string) => void;
  onContextOpen?: () => void;
  density?: 'compact' | 'comfortable' | 'spacious';
  /** Filter/sort/view signature; paging returns to page 1 only when it changes, not on refetch. */
  resetKey?: string;
}) {
  const [page, setPage] = useState(0);
  const { refresh } = useMangaLibrary();
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setPage(0);
  }
  const goToPage = (next: number) => {
    setPage(next);
    window.scrollTo({ top: 0 });
  };
  const pageCount = Math.max(1, Math.ceil(manga.length / 60)),
    currentPage = Math.min(page, pageCount - 1);
  const displayed = manga.slice(currentPage * 60, (currentPage + 1) * 60);
  const navigation = manga.length > 60 && (
    <nav aria-label="Library pages" className="my-4 flex items-center justify-center gap-4 text-sm">
      <button
        type="button"
        disabled={currentPage === 0}
        onClick={() => goToPage(currentPage - 1)}
        className="rounded border p-2 disabled:opacity-40"
      >
        Previous
      </button>
      <span>
        Page {currentPage + 1} of {pageCount}
      </span>
      <button
        type="button"
        disabled={currentPage === pageCount - 1}
        onClick={() => goToPage(currentPage + 1)}
        className="rounded border p-2 disabled:opacity-40"
      >
        Next
      </button>
    </nav>
  );
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
  const selection = (item: Manga) => ({
    selected: selected.includes(item.id),
    selectionMode: selected.length > 0,
    onSelect: onSelect ? () => onSelect(item.id) : undefined,
  });
  return (
    <LibraryTitleContextMenu manga={manga} onOpen={() => onContextOpen?.()} refresh={refresh}>
      <div className="pb-24">
        {navigation}
        {view === 'grid' ? (
          <MangaGrid
            className={density === 'compact' ? '!gap-3' : density === 'spacious' ? '!gap-8' : ''}
          >
            {displayed.map((item) => (
              <MangaCard key={item.id} manga={item} {...selection(item)} />
            ))}
          </MangaGrid>
        ) : (
          <RowList>
            {displayed.map((item) => (
              <LibraryListRow key={item.id} manga={item} {...selection(item)} />
            ))}
          </RowList>
        )}
        {navigation}
      </div>
    </LibraryTitleContextMenu>
  );
}
