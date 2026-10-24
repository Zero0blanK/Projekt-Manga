'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { setMangaInLibrary, type PublicUser } from '@projekt-manga/api-client';
import { MoreVertical, X, Bookmark, Folder, Trash2, BookOpen } from 'lucide-react';
import { actions, getAppState, useAppState } from '@/lib/app-store';
import { libraryActions, useLibraryState } from '@/lib/library-store';
import type { Manga } from '@/lib/manga-data';
import { useCurrentUser } from '@/lib/session-resource';
import { queryClient, queryKeys } from '@/lib/query-client';
import { toast } from '@/hooks/use-toast';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
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
export type LibraryDensity = 'compact' | 'comfortable' | 'spacious';
export function parseDensity(value: unknown): LibraryDensity {
  return value === 'compact' || value === 'spacious' ? value : 'comfortable';
}
type Operation =
  | 'bookmark'
  | 'unbookmark'
  | 'reading'
  | 'completed'
  | 'plan'
  | 'on-hold'
  | 'dropped'
  | 'category'
  | 'remove';
export function LibrarySelectionBar({
  manga,
  visible,
  selected,
  setSelected,
  refresh,
  actionsRequest,
}: {
  manga: Manga[];
  visible: Manga[];
  selected: string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
  refresh: () => void;
  actionsRequest: number;
}) {
  const categories = useAppState((state) => state.customCategories);
  const { bookmarks } = useLibraryState();
  const anyBookmarked = selected.some((id) => bookmarks.includes(id));
  const anyUnbookmarked = selected.some((id) => !bookmarks.includes(id));
  const { user, loading } = useCurrentUser();
  const owner = user?.id ?? 'anonymous';
  const generation = useRef(0);
  const invalidateGeneration = useCallback(() => {
    generation.current++;
  }, []);
  const [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [confirm, setConfirm] = useState(false);
  useEffect(() => {
    invalidateGeneration();
    setSelected([]);
    setOpen(false);
    setBusy(false);
    setConfirm(false);
    return invalidateGeneration;
  }, [owner, setSelected, invalidateGeneration]);
  useEffect(() => {
    if (actionsRequest > 0) setOpen(true);
  }, [actionsRequest]);
  useEffect(() => {
    const clear = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !confirm) {
        setOpen(false);
        setSelected([]);
      }
    };
    window.addEventListener('keydown', clear);
    return () => window.removeEventListener('keydown', clear);
  }, [busy, confirm, setSelected]);
  const run = async (operation: Operation, category?: string) => {
    if (busy || loading || !selected.length) return;
    const version = generation.current;
    const current = () =>
      generation.current === version &&
      (queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? 'anonymous') === owner;
    if (!current()) return;
    const available = new Set(manga.map((item) => item.id)),
      ids = selected.filter((id) => available.has(id));
    setBusy(true);
    setOpen(false);
    const failed: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length && current()) {
        const id = ids[cursor++];
        try {
          if (operation === 'remove') await setMangaInLibrary(id, false);
          else if (operation === 'bookmark' || operation === 'unbookmark')
            await libraryActions.setBookmark(id, operation === 'bookmark');
          else if (operation === 'category') {
            if (!category || !categories.includes(category))
              throw new Error('Category unavailable');
            if (!(getAppState().categoryMembers[category] ?? []).includes(id))
              actions.toggleCategoryMember(category, id);
          } else await libraryActions.setShelf(id, operation);
        } catch {
          failed.push(id);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
      if (!current()) return;
      const processed = new Set(ids);
      setSelected((existing) => [
        ...new Set([...existing.filter((id) => !processed.has(id)), ...failed]),
      ]);
      refresh();
      toast({
        description: failed.length
          ? `${failed.length} ${failed.length === 1 ? 'title' : 'titles'} could not be updated. Retry the remaining selection.`
          : `${ids.length} ${ids.length === 1 ? 'title' : 'titles'} updated.`,
      });
    } finally {
      if (current()) setBusy(false);
    }
  };
  if (!selected.length) return null;
  return (
    <>
      <div
        role="toolbar"
        aria-label="Selected library titles"
        className="fixed inset-x-4 bottom-6 z-40 mx-auto flex max-w-xl items-center gap-3 rounded-2xl border border-primary/30 bg-popover/95 px-4 py-3 shadow-xl backdrop-blur"
      >
        <span role="status" className="min-w-0 flex-1 text-sm font-semibold">
          {busy ? 'Updating…' : `${selected.length} selected`}
        </span>
        <button
          disabled={busy}
          onClick={() => setSelected(visible.map((item) => item.id))}
          className="text-xs text-primary"
        >
          Select all
        </button>
        <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger
            disabled={busy}
            aria-label="Selected title actions"
            className="rounded-lg p-2 hover:bg-accent"
          >
            <MoreVertical size={20} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            {anyUnbookmarked && (
              <DropdownMenuItem onSelect={() => void run('bookmark')}>
                <Bookmark size={16} className="mr-2" />
                Bookmark
              </DropdownMenuItem>
            )}
            {anyBookmarked && (
              <DropdownMenuItem onSelect={() => void run('unbookmark')}>
                Remove bookmark
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <BookOpen size={16} className="mr-2" />
                Move to shelf
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {(['reading', 'completed', 'plan', 'on-hold', 'dropped'] as const).map((shelf) => (
                  <DropdownMenuItem key={shelf} onSelect={() => void run(shelf)}>
                    {
                      {
                        reading: 'Reading',
                        completed: 'Completed',
                        plan: 'Plan to read',
                        'on-hold': 'On hold',
                        dropped: 'Dropped',
                      }[shelf]
                    }
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {categories.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Folder size={16} className="mr-2" />
                  Add to category
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {categories.map((category) => (
                    <DropdownMenuItem
                      key={category}
                      onSelect={() => void run('category', category)}
                    >
                      {category}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setConfirm(true)} className="text-destructive">
              <Trash2 size={16} className="mr-2" />
              Remove from library
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          disabled={busy}
          aria-label="Clear title selection"
          onClick={() => setSelected([])}
          className="rounded-lg p-2 hover:bg-accent"
        >
          <X size={18} />
        </button>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {selected.length === 1 ? 'this title' : `${selected.length} titles`} from your
              library?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Reading history, chapter progress and downloaded files are retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run('remove')}>
              {selected.length === 1 ? 'Remove title' : 'Remove titles'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
