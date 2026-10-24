import type { DownloadRow } from '@/components/downloads/row-data';
import {
  togglePauseDownload,
  removeDownload,
  removeFailedDownloads,
} from '@/components/downloads/actions';
import { IconButton } from '@/components/downloads/icon-button';
import { DownloadCover } from '@/components/downloads/download-cover';
import { StatusPill } from '@/components/downloads/status-pill';
import { Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cancelDownload } from '@projekt-manga/api-client';
import { useCurrentUser } from '@/lib/session-resource';
import { useConfirm } from '@/hooks/use-confirm';

export function ActiveDownloadsList({
  rows,
  onChange,
}: {
  rows: DownloadRow[];
  onChange: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [cleaning, setCleaning] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelMessage, setCancelMessage] = useState('');
  const mounted = useRef(true);
  const cancelling = useRef(false);
  const generation = useRef(0);
  const { user, loading: sessionLoading } = useCurrentUser();
  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    cancelling.current = false;
    setCancelBusy(false);
    setCancelMessage('');
    setSelected([]);
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [user?.id, sessionLoading]);
  const selectedRows = rows.filter((row) => selected.includes(row.id));
  const cancelSelected = async () => {
    if (cancelling.current || sessionLoading || selectedRows.length === 0) return;
    const confirmed = await confirm({
      title: 'Cancel selected downloads?',
      description: `Cancel ${selectedRows.length} selected downloads and remove their partial files?`,
      confirmLabel: 'Cancel downloads',
    });
    if (!confirmed) return;
    cancelling.current = true;
    const requestGeneration = generation.current;
    setCancelBusy(true);
    const removed: string[] = [];
    try {
      for (const row of selectedRows) {
        if (!mounted.current || generation.current !== requestGeneration) break;
        try {
          await cancelDownload(row.id);
          removed.push(row.id);
        } catch {
          /* Failed jobs stay selected for retry. */
        }
      }
      if (mounted.current && generation.current === requestGeneration) {
        setSelected((current) => current.filter((id) => !removed.includes(id)));
        setCancelMessage(
          `Cancelled ${removed.length} of ${selectedRows.length} downloads.${removed.length < selectedRows.length ? ' Failed jobs remain selected for retry.' : ''}`,
        );
      }
      if (mounted.current && generation.current === requestGeneration) onChange();
    } finally {
      if (generation.current === requestGeneration) {
        cancelling.current = false;
        if (mounted.current) setCancelBusy(false);
      }
    }
  };
  const failedRows = rows.filter((row) => row.status === 'failed');
  return (
    <section>
      {dialog}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Active ({rows.length})
        </h2>
        {failedRows.length > 0 && (
          <button
            type="button"
            disabled={cleaning}
            onClick={() => {
              setCleaning(true);
              void removeFailedDownloads(failedRows, confirm, onChange).finally(() =>
                setCleaning(false),
              );
            }}
            className="rounded-md border border-border/60 px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
          >
            {cleaning ? 'Cleaning failed…' : `Clean up ${failedRows.length} failed`}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-primary">
          <button
            type="button"
            disabled={cancelBusy}
            onClick={() => setSelected(rows.map((row) => row.id))}
          >
            Select all active
          </button>
          <button type="button" disabled={cancelBusy} onClick={() => setSelected([])}>
            Clear selection
          </button>
          <button
            type="button"
            disabled={cancelBusy || sessionLoading || selectedRows.length === 0}
            onClick={() => void cancelSelected()}
          >
            {cancelBusy ? 'Cancelling…' : `Cancel selected (${selectedRows.length})`}
          </button>
        </div>
      )}
      {cancelMessage && (
        <p role="status" className="mt-2 text-xs">
          {cancelMessage}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-4 rounded-2xl border border-border/60 bg-surface/40 p-4"
          >
            <input
              type="checkbox"
              disabled={cancelBusy}
              aria-label={`Select ${r.title} ${r.chapters} download`}
              checked={selected.includes(r.id)}
              onChange={() =>
                setSelected((current) =>
                  current.includes(r.id) ? current.filter((id) => id !== r.id) : [...current, r.id],
                )
              }
            />
            <DownloadCover row={r} className="h-14 w-10" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div className="truncate text-sm font-semibold text-foreground">{r.title}</div>
                <div className="shrink-0 text-[11px] text-muted-foreground">
                  {r.chapters} · {r.pages}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-gradient-primary"
                    style={{ width: `${r.progress * 100}%` }}
                  />
                </div>
                <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
                  {Math.round(r.progress * 100)}%
                </span>
                <StatusPill status={r.status} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {r.status !== 'failed' && (
                <IconButton
                  label={r.status === 'paused' ? 'Resume' : 'Pause'}
                  onClick={() => togglePauseDownload(r, onChange)}
                >
                  {r.status === 'paused' ? (
                    <Play className="h-3.5 w-3.5" />
                  ) : (
                    <Pause className="h-3.5 w-3.5" />
                  )}
                </IconButton>
              )}
              <IconButton label="Cancel" onClick={() => removeDownload(r, onChange)}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="rounded-2xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
            Nothing downloading right now.
          </li>
        )}
      </ul>
    </section>
  );
}
