import { Star } from 'lucide-react';
import { artistLine, authorLine, formatRelative, groupLine, type Manga } from '@/lib/manga-data';

export function MangaStatusLabel({ status }: { status: Manga['status'] }) {
  return (
    <div className="text-[10px] font-semibold uppercase leading-none tracking-[0.2em] text-primary">
      {status}
    </div>
  );
}

/** Story/Art/Scanlation credit lines — each supports multiple names. */
export function MangaCredits({ manga }: { manga: Manga }) {
  return (
    <div className="mt-2 space-y-0.5 text-sm text-muted-foreground">
      <p>Story: {authorLine(manga)}</p>
      <p>Art: {artistLine(manga)}</p>
      {groupLine(manga) && <p>Scanlation: {groupLine(manga)}</p>}
    </div>
  );
}

/** The source this title was added from — a manga belongs to exactly one source. */
export function MangaSourceBadges({ manga }: { manga: Manga }) {
  if (!manga.source) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      From
      <span
        className="flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 font-medium text-foreground"
        style={{ background: manga.accent + '22' }}
      >
        {manga.source}
      </span>
    </div>
  );
}

export function MangaStats({ manga }: { manga: Manga }) {
  return (
    <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1">
        {/* An outline star for "no rating"; a filled one would look like a score. */}
        <Star
          aria-hidden="true"
          className={`h-3.5 w-3.5 ${manga.rating !== null ? 'fill-primary text-primary' : 'text-muted-foreground'}`}
        />
        <span
          className={
            manga.rating !== null
              ? 'text-foreground font-semibold tabular-nums'
              : 'text-muted-foreground'
          }
        >
          {manga.rating !== null ? manga.rating.toFixed(1) : 'Not rated'}
        </span>
      </span>
      <span>·</span>
      <span>
        {manga.chapters} {manga.chapters === 1 ? 'chapter' : 'chapters'}
      </span>
      <span>·</span>
      <span>Updated {formatRelative(manga.updatedAt)}</span>
    </div>
  );
}

export function GenrePills({ tags }: { tags: string[] }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}
