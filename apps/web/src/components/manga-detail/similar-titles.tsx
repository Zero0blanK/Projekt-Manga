'use client';

import Link from 'next/link';
import { MangaCover } from '@/components/manga-card';
import { type Manga } from '@/lib/manga-data';
import { useMangaLibrary } from '@/lib/library-store';

export function SimilarTitles({ manga }: { manga: Manga }) {
  const { manga: mangaLibrary } = useMangaLibrary();
  const others = mangaLibrary.filter((m) => m.id !== manga.id);
  const shared = others.filter((m) => m.tags.some((t) => manga.tags.includes(t)));
  const similar = [...shared, ...others.filter((m) => !shared.includes(m))].slice(0, 5);

  if (similar.length === 0) return null;

  return (
    <div className="mt-14">
      <h2 className="text-display text-2xl text-foreground">You might also like</h2>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-5">
        {similar.map((m) => (
          <Link key={m.id} href={`/manga/${m.id}`} className="group">
            <MangaCover manga={m} />
            <div className="mt-2 truncate text-xs font-medium text-foreground group-hover:text-primary">
              {m.title}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
