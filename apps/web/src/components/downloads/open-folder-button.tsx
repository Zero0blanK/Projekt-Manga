'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { FolderOpen, Check } from 'lucide-react';

/** Optional desktop bridge. A browser cannot open a file manager — that's a hard
 * sandbox rule, not a missing feature — so when the app is running inside Electron this
 * hands off to the shell, and otherwise falls back to surfacing the path. */
type DesktopBridge = { openPath?: (path: string) => Promise<unknown> };
function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { desktop?: DesktopBridge }).desktop ?? null;
}

/**
 * Reveals where a download lives on disk. In the desktop build this opens the folder; in
 * a browser it copies the path and shows it, since no web API can launch a file manager.
 */
export function OpenFolderButton({
  path,
  label = 'Show folder',
  className,
  withText = false,
}: {
  path: string | null | undefined;
  label?: string;
  className?: string;
  withText?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // Held so the "copied" reset can be cancelled — a row can unmount while the tick is
  // pending (the downloads list re-renders as the queue drains), leaving a stray timer
  // that fires into nothing.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const reveal = () => {
    if (!path) {
      toast({ description: 'No folder recorded for this download yet.' });
      return;
    }

    const bridge = desktopBridge();
    if (bridge?.openPath) {
      bridge.openPath(path).catch(() => toast({ description: "Couldn't open the folder." }));
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(path).then(
        () => {
          setCopied(true);
          if (copiedTimer.current) clearTimeout(copiedTimer.current);
          copiedTimer.current = setTimeout(() => setCopied(false), 1500);
          toast({ title: 'Folder path copied', description: path });
        },
        () => toast({ title: 'Folder path', description: path }),
      );
      return;
    }
    toast({ title: 'Folder path', description: path });
  };

  return (
    <button
      onClick={reveal}
      disabled={!path}
      aria-label={label}
      title={path ?? label}
      className={
        className ??
        'flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground transition hover:border-primary/50 hover:text-primary disabled:opacity-40'
      }
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <FolderOpen className="h-3.5 w-3.5" />}
      {withText && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}
