'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { setMangaInLibrary, type PublicUser } from '@projekt-manga/api-client';
import { libraryActions, useLibraryState } from '@/lib/library-store';
import { actions, getAppState, useAppState } from '@/lib/app-store';
import { queryClient, queryKeys } from '@/lib/query-client';
import { useCurrentUser } from '@/lib/session-resource';
import type { Manga } from '@/lib/manga-data';
import { toast } from '@/hooks/use-toast';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';

export function LibraryTitleContextMenu({
  children,
  manga,
  onOpen,
  refresh,
}: {
  children: ReactNode;
  manga: Manga[];
  onOpen: () => void;
  refresh: () => void;
}) {
  const [target, setTarget] = useState<Manga | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { bookmarks } = useLibraryState();
  const categories = useAppState((state) => state.customCategories);
  const { user, loading } = useCurrentUser();
  const owner = user?.id ?? 'anonymous';
  useEffect(() => {
    setTarget(null);
    setConfirm(false);
    setBusy(false);
  }, [owner]);
  const run = async (
    action:
      'bookmark' | 'category' | 'remove' | 'reading' | 'completed' | 'plan' | 'on-hold' | 'dropped',
    category?: string,
  ) => {
    if (!target || busy || loading) return;
    const current = () =>
      (queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous') === owner;
    if (!current()) return;
    setBusy(true);
    try {
      if (action === 'bookmark')
        await libraryActions.setBookmark(target.id, !bookmarks.includes(target.id));
      else if (action === 'remove') await setMangaInLibrary(target.id, false);
      else if (action === 'category') {
        if (
          category &&
          categories.includes(category) &&
          !(getAppState().categoryMembers[category] ?? []).includes(target.id)
        )
          actions.toggleCategoryMember(category, target.id);
      } else await libraryActions.setShelf(target.id, action);
      if (current()) refresh();
    } catch {
      if (current()) toast({ description: 'Could not update this title. Please retry.' });
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <>
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          <div
            onContextMenuCapture={(event) => {
              if (
                typeof PointerEvent !== 'undefined' &&
                event.nativeEvent instanceof PointerEvent &&
                event.nativeEvent.pointerType !== 'mouse'
              ) {
                event.preventDefault();
                return;
              }
              const node =
                event.target instanceof Element
                  ? event.target.closest<HTMLElement>('[data-library-selection]')
                  : null;
              const title = manga.find((item) => item.id === node?.dataset.librarySelection);
              if (!title || loading || busy) {
                event.preventDefault();
                return;
              }
              setTarget(title);
              onOpen();
            }}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        {target && (
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => void run('bookmark')}>
              {bookmarks.includes(target.id) ? 'Remove bookmark' : 'Bookmark'}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Move to shelf</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {(['reading', 'completed', 'plan', 'on-hold', 'dropped'] as const).map((shelf) => (
                  <ContextMenuItem key={shelf} onSelect={() => void run(shelf)}>
                    {
                      {
                        reading: 'Reading',
                        completed: 'Completed',
                        plan: 'Plan to read',
                        'on-hold': 'On hold',
                        dropped: 'Dropped',
                      }[shelf]
                    }
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            {categories.length > 0 && (
              <ContextMenuSub>
                <ContextMenuSubTrigger>Add to category</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {categories.map((category) => (
                    <ContextMenuItem key={category} onSelect={() => void run('category', category)}>
                      {category}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem className="text-destructive" onSelect={() => setConfirm(true)}>
              Remove from library
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {target?.title} from your library?</AlertDialogTitle>
            <AlertDialogDescription>
              History, progress and downloads are retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void run('remove')}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
