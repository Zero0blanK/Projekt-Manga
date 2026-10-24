'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { MangaCard } from '@/components/manga-card';
import { MangaGrid } from '@/components/manga-grid';
import { useMangaLibrary, useLibraryState } from '@/lib/library-store';
import { MangaGridSkeleton } from '@/components/skeletons';
import { Bookmark, ArrowUpDown } from 'lucide-react';

const sorts = [
  { value: 'recent', label: 'Recently added' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'rating', label: 'Rating' },
] as const;

export function BookmarksPageClient() {
  const { manga: library, loading: libraryLoading } = useMangaLibrary();
  const { bookmarks, loading: stateLoading } = useLibraryState();
  const loading = libraryLoading || stateLoading;
  const [sort, setSort] = useState<(typeof sorts)[number]['value']>('recent');
  const [sortOpen, setSortOpen] = useState(false);

  const manga = useMemo(() => {
    // Bookmark order is most-recently-toggled-on last; reverse for "recently added" first.
    const list = bookmarks
      .map((id) => library.find((m) => m.id === id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    if (sort === 'title') return [...list].sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'rating') return [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    return [...list].reverse();
  }, [bookmarks, library, sort]);

  return (
    <div className="mx-auto min-w-0 max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-primary">
            <Bookmark className="h-3 w-3 fill-current" /> Bookmarks
          </div>
          <h1 className="mt-1 text-display text-3xl text-foreground sm:text-4xl lg:text-5xl">
            Saved for later
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="text-foreground">{manga.length}</span>{' '}
            {manga.length === 1 ? 'title' : 'titles'} bookmarked
          </p>
        </div>

        {manga.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setSortOpen((v) => !v)}
              className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowUpDown className="h-3.5 w-3.5" /> {sorts.find((s) => s.value === sort)?.label}
            </button>
            {sortOpen && (
              <>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Close sort menu"
                  className="fixed inset-0 z-10"
                  onClick={() => setSortOpen(false)}
                />
                <div className="absolute right-0 top-11 z-20 w-44 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-lg">
                  {sorts.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => {
                        setSort(s.value);
                        setSortOpen(false);
                      }}
                      className={`block w-full px-3 py-2 text-left text-xs transition hover:bg-accent ${
                        sort === s.value ? 'text-primary' : 'text-muted-foreground'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {loading && manga.length === 0 ? (
        <div className="mt-10">
          <MangaGridSkeleton count={6} />
        </div>
      ) : manga.length === 0 ? (
        <div className="mt-12 rounded-2xl border border-dashed border-border/60 p-12 text-center">
          <Bookmark className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing bookmarked yet — tap the bookmark icon on any title to save it here.
          </p>
          <Link
            href="/discover"
            className="mt-3 inline-block text-xs text-primary hover:opacity-80"
          >
            Browse sources
          </Link>
        </div>
      ) : (
        <MangaGrid className="mt-10">
          {manga.map((m) => (
            <MangaCard key={m.id} manga={m} />
          ))}
        </MangaGrid>
      )}
    </div>
  );
}
