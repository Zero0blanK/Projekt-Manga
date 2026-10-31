'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { openCommandPalette } from '@/components/command-palette';
import { useUpdateLibrary } from '@/components/library/update-library-button';
import { useDownloadQueueProgress } from '@/components/downloads/row-data';
import { goToAppPath } from '@/lib/app-navigation';
import {
  setTaskbarBadge,
  setTaskbarProgress,
  subscribeDesktopCommands,
} from '@/lib/desktop-commands';
import { useUnreadUpdateTitles } from '@/lib/unread-updates';
import { localArchiveBridge, localArchiveError } from '@/lib/local-archives';
import { toast } from '@/hooks/use-toast';

/**
 * The desktop app's tray and application menu commands, and progress on the taskbar
 * button: a running library update's, otherwise the download queue's. Renders nothing,
 * and does nothing in a browser.
 */
export function DesktopIntegration() {
  const router = useRouter();
  const update = useUpdateLibrary();
  // The subscription is made once; the handlers it calls are always the current ones.
  const latest = useRef({ router, update });
  latest.current = { router, update };

  useEffect(() => {
    // Comics opened from outside the app: import each, then open the first one read.
    let collecting = false;
    const collectPending = async () => {
      const openPending = localArchiveBridge()?.openPending;
      if (!openPending || collecting) return;
      collecting = true;
      let first: string | null = null;
      try {
        for (let i = 0; i < 10; i++) {
          const imported = await openPending();
          if (!imported) break;
          first ??= imported.id;
        }
      } catch (cause) {
        toast({
          variant: 'destructive',
          description: localArchiveError(cause, 'The comic could not be opened.'),
        });
      } finally {
        collecting = false;
      }
      if (first) latest.current.router.push(`/local-reader/${first}`);
    };
    // "Open with" on first launch queues before this page exists.
    void collectPending();

    // A comic dropped anywhere on the window is imported and opened. Without this the
    // browser would try to open the file itself.
    const dropping = (event: DragEvent) =>
      !!localArchiveBridge()?.importDropped && !!event.dataTransfer?.types.includes('Files');
    const onDragOver = (event: DragEvent) => {
      if (!dropping(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (!dropping(event)) return;
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])].slice(0, 5);
      void (async () => {
        let first: string | null = null;
        for (const file of files) {
          try {
            const imported = await localArchiveBridge()!.importDropped!(file);
            first ??= imported.id;
          } catch (cause) {
            toast({
              variant: 'destructive',
              description: localArchiveError(cause, `${file.name} could not be imported.`),
            });
          }
        }
        if (first) latest.current.router.push(`/local-reader/${first}`);
      })();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    const unsubscribe = subscribeDesktopCommands((command) => {
      const { router: current, update: library } = latest.current;
      if (command.type === 'navigate') goToAppPath(current, command.path);
      else if (command.type === 'command-palette') openCommandPalette();
      else if (command.type === 'open-pending') void collectPending();
      else if (!library.running) void library.updateLibrary();
    });
    return () => {
      unsubscribe();
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const progress = update.progress;
  const downloads = useDownloadQueueProgress();
  // Rounded so a page arriving doesn't call into the main process each time.
  const fraction =
    progress && progress.total > 0
      ? progress.done / progress.total
      : downloads === null
        ? null
        : Math.round(downloads * 100) / 100;
  useEffect(() => {
    setTaskbarProgress(fraction);
  }, [fraction]);
  useEffect(() => () => setTaskbarProgress(null), []);

  // Titles with new chapters not yet looked at, as the nav bell counts them.
  const unreadTitles = useUnreadUpdateTitles().length;
  useEffect(() => {
    setTaskbarBadge(unreadTitles);
  }, [unreadTitles]);
  useEffect(() => () => setTaskbarBadge(0), []);

  return null;
}
