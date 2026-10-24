import { useEffect, useState, type ReactNode } from 'react';
import {
  cleanupOrphanedDownloadFolders,
  getDownloadStats,
  getOrphanedDownloadFolders,
  type DownloadStats,
  type OrphanedDownloadFolder,
} from '@projekt-manga/api-client';
import { Skeleton } from '@/components/ui/skeleton';
import { useDownloadRows } from '@/components/downloads/row-data';
import { useConfirm } from '@/hooks/use-confirm';
import { HardDrive, CheckCircle2, TriangleAlert } from 'lucide-react';

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-display text-4xl text-foreground">{value}</span>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const LOW_DISK_SPACE_BYTES = 1024 ** 3;

export function StorageStats() {
  const { confirm, dialog } = useConfirm();
  const [stats, setStats] = useState<DownloadStats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [orphans, setOrphans] = useState<OrphanedDownloadFolder[]>([]);
  const [orphanError, setOrphanError] = useState(false);
  const [cleaningOrphans, setCleaningOrphans] = useState(false);
  const [orphanNotice, setOrphanNotice] = useState<string | null>(null);
  // Totals are re-read whenever a download finishes, fails or is removed, so they stay in
  // step with the list.
  const { active, completed } = useDownloadRows();
  const downloadsKey = `${completed.length}:${active.filter((row) => row.status === 'failed').length}`;

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    getDownloadStats(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStats(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });
    getOrphanedDownloadFolders(controller.signal)
      .then((folders) => {
        if (!controller.signal.aborted) {
          setOrphans(folders);
          setOrphanError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setOrphanError(true);
      });
    return () => controller.abort();
  }, [retryToken, downloadsKey]);

  async function cleanOrphanedFolders() {
    const selected = orphans.slice(0, 200);
    if (selected.length === 0 || cleaningOrphans) return;
    const estimatedBytes = selected.reduce((total, folder) => total + folder.sizeBytes, 0);
    const examples = selected
      .slice(0, 3)
      .map((folder) => `${folder.title}/${folder.chapterFolder}`)
      .join('\n');
    const confirmed = await confirm({
      title: 'Remove unreferenced folders?',
      description: `Remove ${selected.length} unreferenced download folder${selected.length === 1 ? '' : 's'} older than 24 hours?\nEstimated space: ${formatBytes(estimatedBytes)}${examples ? `\n\n${examples}${selected.length > 3 ? '\n…' : ''}` : ''}`,
      confirmLabel: 'Remove',
    });
    if (!confirmed) return;

    setCleaningOrphans(true);
    try {
      const result = await cleanupOrphanedDownloadFolders(selected.map((folder) => folder.id));
      setOrphanNotice(
        result.removed === selected.length
          ? `Removed ${result.removed} folder${result.removed === 1 ? '' : 's'}; approximately ${formatBytes(result.freedBytes)} freed.`
          : `Removed ${result.removed} of ${selected.length} selected folders. Refreshing the scan may show folders that changed meanwhile.`,
      );
      setRetryToken((value) => value + 1);
    } catch {
      setOrphanError(true);
    } finally {
      setCleaningOrphans(false);
    }
  }

  if (!loaded) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-2xl border border-border/60 bg-surface/40 p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-9 w-16" />
          </div>
        ))}
      </div>
    );
  }
  if (error)
    return (
      <div
        role="alert"
        className="rounded-xl border border-destructive/40 p-4 text-sm text-foreground"
      >
        Storage statistics are unavailable.
        <button
          type="button"
          onClick={() => setRetryToken((value) => value + 1)}
          className="ml-2 text-primary hover:underline"
        >
          Try again
        </button>
      </div>
    );

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {dialog}
      <StatCard
        icon={<HardDrive className="h-4 w-4" />}
        label="Storage used"
        value={stats ? formatBytes(stats.totalSize) : '—'}
        sub="on disk"
      />
      <StatCard
        icon={<HardDrive className="h-4 w-4" />}
        label="Quota remaining"
        value={stats ? formatBytes(Math.max(0, stats.storageLimit - stats.totalSize)) : '—'}
        sub={stats ? `of ${formatBytes(stats.storageLimit)} total` : 'download limit'}
      />
      <StatCard
        icon={<CheckCircle2 className="h-4 w-4" />}
        label="Downloaded"
        value={`${stats?.completed ?? 0}`}
        sub={`${stats?.completed === 1 ? 'chapter' : 'chapters'} available offline`}
      />
      <StatCard
        icon={<TriangleAlert className="h-4 w-4" />}
        label="Failed"
        value={`${stats?.failed ?? 0}`}
        sub="need attention"
      />
      {stats?.freeBytes !== null &&
        stats?.freeBytes !== undefined &&
        stats.freeBytes < LOW_DISK_SPACE_BYTES && (
          <p
            role="status"
            className="col-span-full rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground"
          >
            The download drive has less than 1 GB free. Remove downloads or choose another folder
            before starting large downloads.
          </p>
        )}
      {(orphans.length > 0 || orphanError || orphanNotice) && (
        <section className="col-span-full rounded-xl border border-border/60 bg-surface/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Orphaned download folders</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {orphanError
                  ? 'Could not refresh orphaned folder status.'
                  : `${orphans.length} unreferenced chapter folder${orphans.length === 1 ? '' : 's'} older than 24 hours · ${formatBytes(orphans.reduce((total, folder) => total + folder.sizeBytes, 0))} estimated`}
              </p>
              {orphanError && (
                <button
                  type="button"
                  onClick={() => setRetryToken((value) => value + 1)}
                  className="mt-1 text-xs text-primary hover:underline"
                >
                  Retry scan
                </button>
              )}
            </div>
            {orphans.length > 0 && (
              <button
                type="button"
                disabled={cleaningOrphans}
                onClick={() => void cleanOrphanedFolders()}
                className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                {cleaningOrphans
                  ? 'Cleaning…'
                  : `Review and remove ${Math.min(orphans.length, 200)}`}
              </button>
            )}
          </div>
          {orphans.length > 0 && (
            <ul className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              {orphans.slice(0, 6).map((folder) => (
                <li key={folder.id} className="truncate">
                  {folder.title} / {folder.chapterFolder} · {folder.pageCount} pages
                </li>
              ))}
              {orphans.length > 6 && <li>and {orphans.length - 6} more</li>}
            </ul>
          )}
          {orphanNotice && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {orphanNotice}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
