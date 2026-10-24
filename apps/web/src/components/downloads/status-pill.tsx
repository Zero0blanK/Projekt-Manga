import type { DownloadRow } from '@/components/downloads/row-data';

const STATUS_MAP: Record<DownloadRow['status'], { label: string; cls: string }> = {
  downloading: { label: 'Downloading', cls: 'bg-primary/15 text-primary' },
  paused: { label: 'Paused', cls: 'bg-muted text-muted-foreground' },
  queued: { label: 'Queued', cls: 'bg-secondary text-secondary-foreground' },
  done: { label: 'Done', cls: 'bg-primary/10 text-primary' },
  failed: { label: 'Failed', cls: 'bg-destructive/15 text-destructive' },
};

export function StatusPill({ status }: { status: DownloadRow['status'] }) {
  const map = STATUS_MAP[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${map.cls}`}>
      {map.label}
    </span>
  );
}
