'use client';

import { toast } from '@/hooks/use-toast';
import { useMangaLibrary, useLibraryState } from '@/lib/library-store';
import { useAppState, useSetting } from '@/lib/app-store';
import { sendChapterAlert } from '@projekt-manga/api-client';
import { isQuietHours } from '@/lib/notification-preferences';
import {
  CATEGORY_UPDATE_SETTING,
  chapterAlertTitles,
  parseMutedCategories,
} from '@/lib/update-schedule';
import { entriesInGlobalUpdate, useGlobalUpdateRules } from '@/lib/library-update';
import { runLibraryUpdate, useLibraryUpdateProgress } from '@/lib/run-library-update';
import { RefreshCw } from 'lucide-react';
import { showWindowNotification } from '@/lib/window-notification';

/**
 * "Update library": the button below, the command palette, and the desktop tray and app
 * menu all start the same check with the same toasts.
 */
export function useUpdateLibrary() {
  const progress = useLibraryUpdateProgress();
  const { manga: library, refresh } = useMangaLibrary();
  const { shelf } = useLibraryState();
  // Settings > Sync & Storage > Library updates. Smart update is for scheduled runs only:
  // pressing the button means "check everything now".
  const updateRules = useGlobalUpdateRules();
  const showDesktop = useSetting('notifyDesktop', false) as boolean;
  const reportErrors = useSetting('notifyUpdateErrors', true) as boolean;
  const refreshCovers = useSetting('refreshCoversOnUpdate', false) as boolean;
  const quietHoursEnabled = useSetting('quietHoursEnabled', false) as boolean;
  const quietHoursStart = useSetting('quietHoursStart', '22:00') as string;
  const quietHoursEnd = useSetting('quietHoursEnd', '07:00') as string;
  const mutedCategories = useSetting(CATEGORY_UPDATE_SETTING.mutedCategories, '') as string;
  const settings = useAppState((state) => state.settings);
  const categoryMembers = useAppState((state) => state.categoryMembers);
  const manga = entriesInGlobalUpdate(library, shelf, updateRules);
  const running = progress !== null;

  /**
   * Walks the library one title at a time instead of the single bulk endpoint, so the
   * UI can report real progress ("4 / 12") rather than spinning blindly — the bulk call
   * returns nothing until every source has been scraped, which can take minutes.
   * Sequential on purpose: these are live scrapes and shouldn't all fire at once.
   */
  const updateLibrary = async () => {
    if (running || manga.length === 0) return;
    const { found, failed, cancelled, foundByManga, foundTitles } = await runLibraryUpdate(manga, {
      refreshCovers,
    });
    // Settings › Notifications › Outside the app: the same alert a scheduled update sends,
    // with the same muted sources, categories and quiet hours. Chapters found before a
    // cancel are announced too: they are in the library now.
    if (
      found > 0 &&
      !(quietHoursEnabled && isQuietHours(new Date(), quietHoursStart, quietHoursEnd))
    ) {
      const byId = new Map(manga.map((entry) => [entry.id, entry]));
      const titles = chapterAlertTitles(
        foundByManga,
        (mangaId) => foundTitles?.[mangaId] ?? byId.get(mangaId)?.title,
        {
          sourceOf: (mangaId) => byId.get(mangaId)?.source,
          sourceNotifies: (source) => settings[`notifySource:${source}`] !== false,
          mutedCategories: parseMutedCategories(mutedCategories),
          categoryMembers,
        },
      );
      if (titles.length) void sendChapterAlert({ titles }).catch(() => undefined);
    }
    // Chapters found before a cancel are stored: their unread counts still need showing.
    if (cancelled) {
      if (found > 0) refresh();
      return;
    }
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

  return { updateLibrary, progress, running, titleCount: manga.length };
}

export function UpdateLibraryButton() {
  const { updateLibrary, progress, running, titleCount } = useUpdateLibrary();
  return (
    <>
      {/* Icon-only, sized to match ViewToggle and the library filters beside it. It keeps
          the primary fill because it is the one action in that row rather than a toggle.
          Progress is shown by LibraryUpdateDial, so the toolbar never resizes. */}
      <button
        onClick={updateLibrary}
        disabled={running || titleCount === 0}
        aria-label={
          progress ? `Updating library, ${progress.done} of ${progress.total}` : 'Update library'
        }
        title={progress ? `Updating ${progress.done}/${progress.total}` : 'Update library'}
        className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow transition hover:opacity-90 disabled:opacity-60"
      >
        <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
      </button>
    </>
  );
}
