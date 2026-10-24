import { toast } from '@/hooks/use-toast';
import { pauseDownload, resumeDownload, cancelDownload } from '@projekt-manga/api-client';
import type { DownloadRow } from '@/components/downloads/row-data';
import type { Confirm } from '@/hooks/use-confirm';

export function togglePauseDownload(row: DownloadRow, onDone?: () => void) {
  const mutate = row.status === 'paused' ? resumeDownload : pauseDownload;
  mutate(row.id)
    .then(() => onDone?.())
    .catch(() => toast({ description: `Couldn't update ${row.title} — try again` }));
}

export function removeDownload(row: DownloadRow, onDone?: () => void) {
  cancelDownload(row.id)
    .then(() => {
      toast({ description: `Removed ${row.title} from downloads` });
      onDone?.();
    })
    .catch(() => toast({ description: `Couldn't remove ${row.title} — try again` }));
}

export async function removeFailedDownloads(
  rows: DownloadRow[],
  confirm: Confirm,
  onDone?: () => void,
) {
  if (rows.length === 0) return;
  const confirmed = await confirm({
    title: 'Remove failed downloads?',
    description: `Remove ${rows.length} failed download${rows.length === 1 ? '' : 's'} and any partial files?`,
    confirmLabel: 'Remove',
  });
  if (!confirmed) return;

  let removed = 0;
  for (const row of rows) {
    try {
      await cancelDownload(row.id);
      removed += 1;
    } catch {
      // Continue so one stale record does not prevent cleanup of the remaining failures.
    }
  }
  onDone?.();
  toast({
    description:
      removed === rows.length
        ? `Removed ${removed} failed download${removed === 1 ? '' : 's'}`
        : `Removed ${removed} of ${rows.length} failed downloads. Refresh and retry the rest.`,
  });
}

export async function removeSeriesDownloads(
  rows: DownloadRow[],
  confirm: Confirm,
  onDone?: () => void,
) {
  if (rows.length === 0) return;
  const confirmed = await confirm({
    title: 'Remove series downloads?',
    description: `Remove all ${rows.length} downloaded chapter${rows.length === 1 ? '' : 's'} for ${rows[0].title} from this device?`,
    confirmLabel: 'Remove',
  });
  if (!confirmed) return;

  let removed = 0;
  for (const row of rows) {
    try {
      await cancelDownload(row.id);
      removed += 1;
    } catch {
      // Continue; report partial cleanup so a stale row can be retried individually.
    }
  }
  onDone?.();
  toast({
    description:
      removed === rows.length
        ? `Removed all ${removed} downloaded chapters for ${rows[0].title}`
        : `Removed ${removed} of ${rows.length} chapters for ${rows[0].title}. Refresh and retry the rest.`,
  });
}
