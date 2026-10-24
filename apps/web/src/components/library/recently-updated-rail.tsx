'use client';

import Link from 'next/link';
import { Cover } from '@/components/cover';
import { formatRelative } from '@/lib/manga-data';
import { useMangaLibrary } from '@/lib/library-store';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronRight } from 'lucide-react';

export function RecentlyUpdatedRail() {
  const { manga, loading } = useMangaLibrary();
  const recentlyUpdated = [...manga]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 8);

  return (
    <aside className="hidden w-[340px] shrink-0 border-l border-border/60 bg-surface/30 xl:block">
      <div className="sticky top-16 px-6 py-6">
        <div className="flex items-center justify-between">
          <h3 className="text-display text-2xl text-foreground">Recently Updated</h3>
          <Link
            href="/recents"
            className="flex items-center gap-1 text-xs text-primary hover:opacity-80"
          >
            More <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
        <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          Latest across your sources
        </p>

        <ul className="mt-5 space-y-1.5">
          {loading && manga.length === 0
            ? Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="flex items-center gap-3 p-2">
                  <Skeleton className="h-14 w-10 shrink-0 rounded-md" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-4/5" />
                    <Skeleton className="h-2.5 w-1/3" />
                  </div>
                </li>
              ))
            : recentlyUpdated.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/manga/${m.id}`}
                    className="group flex items-center gap-3 rounded-xl p-2 transition hover:bg-accent"
                  >
                    <Cover
                      sourceId={m.source}
                      src={m.thumbnailUrl}
                      alt={m.title}
                      className="h-14 w-10 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                        {m.title}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        Chapter {m.latestChapterNum}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatRelative(m.updatedAt)}
                    </div>
                  </Link>
                </li>
              ))}
        </ul>
      </div>
    </aside>
  );
}
