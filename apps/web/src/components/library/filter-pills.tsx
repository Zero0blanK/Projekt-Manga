import { useRef, useState } from 'react';
import type { Manga } from '@/lib/manga-data';
import { useMangaLibrary, useLibraryState } from '@/lib/library-store';
import { actions, useAppState } from '@/lib/app-store';
import { filters, shelfOf as resolveShelf } from '@/components/library/constants';
import { Plus } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function FilterPills({
  filter,
  onChange,
}: {
  filter: string;
  onChange: (value: string) => void;
}) {
  const { manga: mangaLibrary } = useMangaLibrary();
  const { shelf } = useLibraryState();
  const customCategories = useAppState((s) => s.customCategories);
  const categoryMembers = useAppState((s) => s.categoryMembers);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const categoryTriggers = useRef(new Map<string, HTMLButtonElement>());
  const editFocusTarget = useRef<HTMLButtonElement | null>(null);
  const deleteFocusTarget = useRef<HTMLButtonElement | null>(null);
  const addCategoryTrigger = useRef<HTMLButtonElement | null>(null);

  const shelfOf = (m: Manga) => resolveShelf(m, shelf);

  const submitCategory = () => {
    const trimmed = name.trim();
    if (trimmed) {
      actions.addCategory(trimmed);
      onChange(trimmed);
    }
    setName('');
    setAdding(false);
  };

  const openEdit = (category: string) => {
    editFocusTarget.current = categoryTriggers.current.get(category) ?? null;
    setEditing(category);
    setEditName(category);
  };

  const submitEdit = () => {
    if (!editing) return;
    const trimmed = editName.trim();
    actions.renameCategory(editing, trimmed);
    if (filter === editing && trimmed) onChange(trimmed);
    setEditing(null);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    actions.removeCategory(deleting);
    if (filter === deleting) onChange('all');
    setDeleting(null);
  };

  return (
    // One scrolling row on phones: wrapped, the shelves took two rows above the title.
    <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
      {filters.map((f) => {
        const count =
          f.value === 'all'
            ? mangaLibrary.length
            : mangaLibrary.filter((m) => shelfOf(m) === f.value).length;
        const on = filter === f.value;
        return (
          <button
            key={f.value}
            onClick={() => onChange(f.value)}
            aria-pressed={on}
            className={`shrink-0 rounded-full px-3.5 pointer-coarse:min-h-9 py-1.5 text-xs font-medium transition ${
              on
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'border border-border/60 bg-surface/40 text-muted-foreground hover:border-border hover:text-foreground'
            }`}
          >
            {f.label}
            <span className={`ml-1.5 tabular-nums ${on ? 'opacity-80' : 'opacity-60'}`}>
              {count}
            </span>
          </button>
        );
      })}

      {customCategories.map((c) => {
        const on = filter === c;
        const count = categoryMembers[c]?.length ?? 0;
        return (
          <ContextMenu key={c}>
            <ContextMenuTrigger asChild>
              <button
                ref={(element) => {
                  if (element) categoryTriggers.current.set(c, element);
                  else categoryTriggers.current.delete(c);
                }}
                onClick={() => onChange(c)}
                aria-pressed={on}
                className={`shrink-0 rounded-full px-3.5 pointer-coarse:min-h-9 py-1.5 text-xs font-medium transition ${
                  on
                    ? 'bg-primary text-primary-foreground shadow-glow'
                    : 'border border-border/60 bg-surface/40 text-muted-foreground hover:border-border hover:text-foreground'
                }`}
              >
                {c}
                <span className={`ml-1.5 tabular-nums ${on ? 'opacity-80' : 'opacity-60'}`}>
                  {count}
                </span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => openEdit(c)}>Edit</ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  deleteFocusTarget.current = categoryTriggers.current.get(c) ?? null;
                  setDeleting(c);
                }}
                className="text-destructive focus:text-destructive"
              >
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {adding ? (
        <div className="flex items-center rounded-full border border-primary/50 bg-surface/40 px-3 py-1.5">
          <input
            autoFocus
            // A placeholder is not an accessible name: it is not exposed as one by every
            // screen reader, and it disappears as soon as the field has a character in
            // it. This field is also focused on open, so it is the first thing announced.
            aria-label="New category name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCategory();
              if (e.key === 'Escape') {
                setName('');
                setAdding(false);
              }
            }}
            onBlur={submitCategory}
            placeholder="Category name"
            className="w-28 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : (
        <button
          ref={addCategoryTrigger}
          onClick={() => setAdding(true)}
          aria-label="Add category"
          className="flex shrink-0 items-center gap-1 rounded-full border border-dashed pointer-coarse:min-h-9 border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-border hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" /> New category
        </button>
      )}

      {customCategories.includes(filter) && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => openEdit(filter)}>
            Rename category
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              deleteFocusTarget.current = categoryTriggers.current.get(filter) ?? null;
              setDeleting(filter);
            }}
          >
            Delete category
          </Button>
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent
          className="sm:max-w-sm"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = editFocusTarget.current;
            editFocusTarget.current = null;
            (target?.isConnected ? target : addCategoryTrigger.current)?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename category</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitEdit();
            }}
            placeholder="Category name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={submitEdit} disabled={!editName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = deleteFocusTarget.current;
            deleteFocusTarget.current = null;
            (target?.isConnected ? target : addCategoryTrigger.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleting}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the category and its manga assignments. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
