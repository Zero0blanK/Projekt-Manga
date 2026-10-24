import Link from 'next/link';
import type { DownloadRow } from '@/components/downloads/row-data';
import { removeDownload, removeSeriesDownloads } from '@/components/downloads/actions';
import { IconButton } from '@/components/downloads/icon-button';
import { OpenFolderButton } from '@/components/downloads/open-folder-button';
import { DownloadCover } from '@/components/downloads/download-cover';
import { formatRelative } from '@/lib/manga-data';
import { CheckCircle2, Trash2, Play } from 'lucide-react';
import { useMemo } from 'react';
import { useConfirm } from '@/hooks/use-confirm';

export function CompletedDownloadsList({
  rows,
  onChange,
}: {
  rows: DownloadRow[];
  onChange: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const groups = useMemo(() => {
    const byManga = new Map<string, DownloadRow[]>();
    for (const row of rows) {
      const group = byManga.get(row.mangaId) ?? [];
      group.push(row);
      byManga.set(row.mangaId, group);
    }
    return [...byManga.entries()];
  }, [rows]);

  return (
    <section>
      {dialog}
      <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Available offline ({rows.length})
      </h2>
      <ul className="mt-3 divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
        {groups.map(([mangaId, seriesRows]) => (
          <li key={mangaId}>
            {seriesRows.length > 1 && (
              <div className="flex items-center justify-between gap-3 border-b border-border/50 bg-muted/20 px-4 py-2">
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {seriesRows[0].title} · {seriesRows.length} chapters
                </span>
                <button
                  type="button"
                  onClick={() => void removeSeriesDownloads(seriesRows, confirm, onChange)}
                  className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
                >
                  Remove series downloads
                </button>
              </div>
            )}
            <ul className="divide-y divide-border/60">
              {seriesRows.map((r) => (
                <li key={r.id} className="flex items-center gap-4 p-4">
                  <DownloadCover row={r} className="h-14 w-10" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">{r.title}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {r.chapters} · {r.pages} · added {formatRelative(r.addedAt)}
                    </div>
                  </div>
                  <div className="hidden shrink-0 items-center gap-2 text-[11px] text-primary sm:flex">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Ready
                  </div>
                  <Link
                    href={`/reader/${r.mangaId}?ch=${r.chapterNumber}`}
                    className="flex shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[11px] font-semibold text-background transition hover:opacity-90"
                  >
                    <Play className="h-3 w-3 fill-current" /> Read
                  </Link>
                  <OpenFolderButton path={r.folderPath} />
                  <IconButton label="Delete" onClick={() => removeDownload(r, onChange)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="p-8 text-center text-sm text-muted-foreground">Nothing downloaded yet.</li>
        )}
      </ul>
    </section>
  );
}
