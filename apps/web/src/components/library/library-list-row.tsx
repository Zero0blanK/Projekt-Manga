'use client';

import Link from 'next/link';
import { toast } from '@/hooks/use-toast';
import { actions, useAppState, type ShelfStatus } from '@/lib/app-store';
import { applyLibraryAction, libraryActions, useLibraryState } from '@/lib/library-store';
import { authorLine, formatRelative, type Manga } from '@/lib/manga-data';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { filters, shelfOf as resolveShelf } from '@/components/library/constants';
import { Cover } from '@/components/cover';
import { Play, ChevronDown, Tag, Check } from 'lucide-react';
import { useHoldToSelect } from '@/hooks/use-hold-to-select';

export function LibraryListRow({
  manga,
  selected = false,
  selectionMode = false,
  onSelect,
  onOpenActions,
}: {
  manga: Manga;
  selected?: boolean;
  selectionMode?: boolean;
  onSelect?: () => void;
  onOpenActions?: () => void;
}) {
  const hold = useHoldToSelect({ onSelect: () => onSelect?.(), disabled: !onSelect });
  const { shelf: shelfMap } = useLibraryState();
  const shelf = resolveShelf(manga, shelfMap);
  const customCategories = useAppState((s) => s.customCategories);
  const categoryMembers = useAppState((s) => s.categoryMembers);
  const inCategories = customCategories.filter((c) =>
    (categoryMembers[c] ?? []).includes(manga.id),
  );
  const progress = manga.progress ?? 0;
  const chapter = manga.currentChapter ?? 1;

  return (
    <li
      {...hold}
      onPointerDown={(event) => {
        hold.onPointerDown(event);
        if (onSelect && event.pointerType !== 'mouse') event.stopPropagation();
      }}
      data-library-selection={manga.id}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={
        onSelect
          ? `${manga.title}${selected ? ', selected' : ', hold or press Space to select'}`
          : undefined
      }
      onClickCapture={(event) => {
        hold.onClickCapture(event);
        if (event.defaultPrevented) return;
        if (
          selectionMode &&
          !(event.target instanceof Element && event.target.closest('button, [role="menuitem"]'))
        ) {
          event.preventDefault();
          event.stopPropagation();
          onSelect?.();
        }
      }}
      onContextMenu={(event) => {
        if (onOpenActions) {
          event.preventDefault();
          onOpenActions();
        }
      }}
      onDragStart={(event) => {
        if (onSelect) event.preventDefault();
      }}
      className={`flex items-center gap-4 p-3.5 transition ${selectionMode ? '' : 'group'} ${selected ? 'bg-primary/15 ring-1 ring-inset ring-primary' : 'hover:bg-accent/40'} ${onSelect ? 'select-none touch-pan-y' : ''}`}
    >
      <Cover
        sourceId={manga.source}
        src={manga.thumbnailUrl}
        alt={manga.title}
        className="h-16 w-11 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <Link
          href={`/manga/${manga.id}`}
          className="block truncate text-sm font-semibold text-foreground group-hover:text-primary"
        >
          {manga.title}
        </Link>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {authorLine(manga)} · {manga.latestChapter} · {formatRelative(manga.updatedAt)}
        </div>
        <div className="mt-2 h-1 w-full max-w-48 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-gradient-primary"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger className="hidden h-7 min-w-28 items-center justify-between gap-1.5 rounded-lg border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary sm:flex">
          {shelf ? filters.find((f) => f.value === shelf)?.label : 'No shelf'}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {filters.slice(1).map((f) => (
            <DropdownMenuItem
              key={f.value}
              onSelect={() => {
                applyLibraryAction(
                  libraryActions.setShelf(manga.id, f.value as ShelfStatus),
                  "Couldn't move this title — it's been restored.",
                );
                toast({ description: `${manga.title} moved to ${f.label}` });
              }}
              className={`text-[11px] ${f.value === shelf ? 'text-primary' : ''}`}
            >
              {f.label}
            </DropdownMenuItem>
          ))}
          {shelf && (
            <DropdownMenuItem
              onSelect={() => {
                applyLibraryAction(
                  libraryActions.removeShelf(manga.id),
                  "Couldn't clear this shelf — it's been restored.",
                );
                toast({ description: `${manga.title} removed from ${shelf}` });
              }}
              className="text-[11px] text-muted-foreground"
            >
              Clear shelf
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {customCategories.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Categories"
            aria-pressed={inCategories.length > 0}
            className={`grid h-7 w-7 pointer-coarse:size-11 shrink-0 place-items-center rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              inCategories.length > 0
                ? 'border-primary/50 bg-primary/10 text-primary'
                : 'border-border/60 bg-background text-muted-foreground'
            }`}
          >
            <Tag className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {customCategories.map((c) => {
              const active = inCategories.includes(c);
              return (
                <DropdownMenuItem
                  key={c}
                  onSelect={(e) => {
                    e.preventDefault();
                    actions.toggleCategoryMember(c, manga.id);
                  }}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  {c}
                  {active && <Check className="h-3.5 w-3.5 text-primary" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Link
        href={`/reader/${manga.id}?ch=${chapter}${manga.currentPage ? `&page=${manga.currentPage}` : ''}`}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[11px] font-semibold text-background transition hover:opacity-90"
      >
        <Play className="h-3 w-3 fill-current" /> Read
      </Link>
    </li>
  );
}
