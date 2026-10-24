'use client';

import { toast } from '@/hooks/use-toast';
import { useMangaLibrary, useLibraryState } from '@/lib/library-store';
import { useSetting } from '@/lib/app-store';
import { entriesInGlobalUpdate } from '@/lib/library-update';
import { runLibraryUpdate, useLibraryUpdateProgress } from '@/lib/run-library-update';
import { RefreshCw } from 'lucide-react';
import { showWindowNotification } from '@/lib/window-notification';

export function UpdateLibraryButton() {
  const progress = useLibraryUpdateProgress();
  const { manga: library, refresh } = useMangaLibrary();
  const { shelf } = useLibraryState();
  // Settings > Sync & Storage > Skip finished titles.
  const skipCompleted = useSetting('skipCompletedOnUpdate', false) as boolean;
  const showDesktop = useSetting('notifyDesktop', false) as boolean;
  const reportErrors = useSetting('notifyUpdateErrors', true) as boolean;
  const refreshCovers = useSetting('refreshCoversOnUpdate', false) as boolean;
  const manga = entriesInGlobalUpdate(library, shelf, skipCompleted);
  const running = progress !== null;

  /**
   * Walks the library one title at a time instead of the single bulk endpoint, so the
   * UI can report real progress ("4 / 12") rather than spinning blindly — the bulk call
   * returns nothing until every source has been scraped, which can take minutes.
   * Sequential on purpose: these are live scrapes and shouldn't all fire at once.
   */
  const updateLibrary = async () => {
    if (running || manga.length === 0) return;
    const { found, failed, cancelled } = await runLibraryUpdate(manga, { refreshCovers });
    if (cancelled) return;
    refresh();

    const summary =
      found > 0
        ? `${found} new chapter${found === 1 ? '' : 's'} across ${manga.length} titles.`
        : failed.length > 0
          ? `No new chapters found in the titles that could be checked.`
          : `No new chapters found across ${manga.length} titles.`;
    toast({
      title: failed.length > 0 ? 'Library check incomplete' : 'Library up to date',
      description: summary,
    });
    if (found > 0 && showDesktop) {
      showWindowNotification({
        title: 'New chapters available',
        body: summary,
        tag: 'library-update',
        destination: '/notifications',
      });
    }

    // Settings > Notifications > Update errors. Named titles rather than a bare count,
    // so a consistently failing source is identifiable.
    if (reportErrors && failed.length > 0) {
      const named = failed.slice(0, 3).join(', ');
      toast({
        variant: 'destructive',
        title: `${failed.length} title${failed.length === 1 ? '' : 's'} couldn't be checked`,
        description: failed.length > 3 ? `${named}, and ${failed.length - 3} more.` : `${named}.`,
      });
    }
  };

  return (
    <>
      {/* Icon-only, sized to match ViewToggle and the library filters beside it. It keeps
          the primary fill because it is the one action in that row rather than a toggle.
          Progress is shown by LibraryUpdateDial, so the toolbar never resizes. */}
      <button
        onClick={updateLibrary}
        disabled={running || manga.length === 0}
        aria-label={
          running ? `Updating library, ${progress.done} of ${progress.total}` : 'Update library'
        }
        title={running ? `Updating ${progress.done}/${progress.total}` : 'Update library'}
        className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow transition hover:opacity-90 disabled:opacity-60"
      >
        <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
      </button>
    </>
  );
}
