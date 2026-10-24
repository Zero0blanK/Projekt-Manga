'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDownloadQueueCount } from '@/components/downloads/row-data';
import { Download } from 'lucide-react';

/**
 * Links straight to the download manager. The badge counts everything not yet finished
 * (queued, downloading, paused, failed) and updates live from the download progress
 * stream, so a running queue is visible from anywhere in the app.
 */
export function NavDownloads() {
  const pathname = usePathname();
  const isActive = pathname.startsWith('/downloads');
  const queued = useDownloadQueueCount();

  return (
    <Link
      href="/downloads"
      aria-label={queued > 0 ? `Downloads, ${queued} in queue` : 'Downloads'}
      aria-current={isActive ? 'page' : undefined}
      className={`group relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-primary ${
        isActive
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      <Download size={20} />
      {queued > 0 && (
        <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold tabular-nums text-primary-foreground">
          {queued > 99 ? '99+' : queued}
        </span>
      )}
      <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border/60 bg-popover px-2 py-1 text-[10px] font-medium text-foreground opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
        {queued > 0 ? `Downloads · ${queued} in queue` : 'Downloads'}
      </span>
    </Link>
  );
}
