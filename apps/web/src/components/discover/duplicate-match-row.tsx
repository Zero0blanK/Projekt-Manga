'use client';

import { Cover } from '@/components/cover';
import type { DuplicateMatch } from '@/lib/duplicate-detection';

/** One possible duplicate, with the two things you can do about it. Presentational
 * only — every decision belongs to the dialog that owns the add. */
export function MatchRow({
  match,
  busy,
  onShow,
  onMigrate,
}: {
  match: DuplicateMatch;
  busy: boolean;
  onShow: () => void;
  onMigrate: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 p-2">
      <Cover
        sourceId={match.manga.source}
        src={match.manga.thumbnailUrl}
        alt=""
        className="h-16 w-11 shrink-0"
        sizes="44px"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{match.manga.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {match.manga.source}
          {match.exact ? ' · same title' : ` · ${Math.round(match.score * 100)}% similar`}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          onClick={onShow}
          disabled={busy}
          className="rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
        >
          Show entry
        </button>
        <button
          onClick={onMigrate}
          disabled={busy}
          className="rounded-lg border border-primary/50 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20 disabled:opacity-50"
        >
          Migrate
        </button>
      </div>
    </div>
  );
}
