import type { ReactNode } from 'react';
import type { Manga } from '@/lib/manga-data';
import { MangaDetailBackLink } from '@/components/manga-detail/back-link';
import { MangaCoverDialog } from '@/components/manga-detail/cover-dialog';
import {
  MangaStatusLabel,
  MangaCredits,
  MangaSourceBadges,
  MangaStats,
  GenrePills,
} from '@/components/manga-detail/manga-info';
import { MangaSynopsis } from '@/components/manga-detail/synopsis';

/**
 * The shared shell for both manga detail pages. The library page and the source preview
 * pass the same normalised `Manga`, so cover, credits, stats, genres and synopsis render
 * identically; only the action row and chapter list differ, because a source title has no
 * local shelf, bookmark or read state to act on.
 */
export function MangaDetailLayout({
  manga,
  backHref,
  backLabel,
  actions,
  children,
}: {
  manga: Manga;
  /** Only used when there's no in-app history to go back to — a deep link or new tab. */
  backHref: string;
  backLabel: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <div
        className="absolute inset-x-0 top-0 h-80 opacity-70"
        style={{
          background: `radial-gradient(60% 100% at 30% 0%, ${manga.accent}44, transparent 70%)`,
        }}
      />

      <div className="relative mx-auto max-w-6xl px-4 py-6 sm:px-8">
        <MangaDetailBackLink fallbackHref={backHref} fallbackLabel={backLabel} />

        {/* On phones the cover sits beside the title instead of above it, and the rest
            spans the full width below, so the chapter list isn't pushed far down. From md
            up the info column runs beside the cover. */}
        <div className="mt-6 grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-x-8">
          <div className="md:row-span-2">
            <MangaCoverDialog manga={manga} />
          </div>

          <div className="min-w-0">
            <MangaStatusLabel status={manga.status} />
            <h1 className="mt-2 text-display text-2xl leading-[1.05] text-foreground sm:text-4xl md:text-5xl md:leading-[1.02]">
              {manga.title}
            </h1>
            <MangaCredits manga={manga} />
            <MangaSourceBadges manga={manga} />
          </div>

          <div className="col-span-2 min-w-0 md:col-span-1 md:col-start-2">
            <MangaStats manga={manga} />
            <GenrePills tags={manga.tags} />
            <MangaSynopsis synopsis={manga.synopsis} />
            <div className="mt-6 flex flex-wrap items-center gap-2">{actions}</div>
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}
