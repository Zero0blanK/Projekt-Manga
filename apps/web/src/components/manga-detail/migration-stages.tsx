'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  BookOpen,
  Bookmark,
  Folder,
  Layers,
  Loader2,
  RefreshCw,
  Check,
  AlertCircle,
  Search,
  GripVertical,
  Plus,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  type LucideIcon,
} from 'lucide-react';
import { buildImageProxyUrl } from '@projekt-manga/api-client';
import type { MangaDetails, Mangas } from '@projekt-manga/types';
import type { Manga } from '@/lib/manga-data';
import { Cover } from '@/components/cover';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

import { useHoldToSelect } from '@/hooks/use-hold-to-select';
import { sourceLanguageName } from '@/lib/source-language';
import type { MigrationOptions, MigrationSearchStatus } from '@/lib/migration-state';
export type { MigrationOptions, MigrationSearchStatus } from '@/lib/migration-state';
export type MigrationPreviewStatus = 'idle' | 'loading' | 'error' | 'ready';
export type MigrationTransferStatus =
  | { state: 'idle' }
  | { state: 'saving'; label: string }
  | { state: 'partial'; failed: string[]; message: string }
  | { state: 'success'; targetId: string };
type SourceLabel = { id: string; name: string; lang: string };
const optionInfo = {
  read: {
    label: 'Completed progress',
    hint: 'Match chapters you have finished reading.',
    icon: BookOpen,
  },
  shelf: { label: 'Reading shelf', hint: 'Keep your current reading status.', icon: Layers },
  bookmark: { label: 'Bookmark', hint: 'Carry over the title bookmark.', icon: Bookmark },
  categories: {
    label: 'Categories',
    hint: 'Keep the title in your existing categories.',
    icon: Folder,
  },
};

export function MigrationTitleSummary({ manga, sourceName }: { manga: Manga; sourceName: string }) {
  return (
    <div className="mb-7 flex items-center gap-4 rounded-2xl border border-border/60 bg-surface/40 p-3 pr-5">
      <Cover
        sourceId={manga.source}
        src={manga.thumbnailUrl}
        alt=""
        className="aspect-[2/3] w-12 shrink-0 sm:w-14"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
          Migrating from
        </p>
        <h2 title={manga.title} className="mt-1 truncate text-base font-semibold sm:text-lg">
          {manga.title}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {sourceName}
          {manga.chapters > 0 && ` · ${manga.chapters} chapter${manga.chapters === 1 ? '' : 's'}`}
        </p>
      </div>
    </div>
  );
}

function MigrationToggle({
  label,
  hint,
  checked,
  disabled,
  onToggle,
  icon: Icon,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className="flex min-h-20 w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-50 sm:px-5"
    >
      {Icon && <Icon size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-primary' : 'bg-muted'}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-background transition ${checked ? 'left-[22px]' : 'left-0.5'}`}
        />
      </span>
    </button>
  );
}

export function MigrationOptionsStage({
  sources,
  selectedIds,
  options,
  hideUnmatched,
  disabled,
  onSources,
  onOptions,
  onHideUnmatched,
  onApply,
}: {
  sources: SourceLabel[];
  selectedIds: string[];
  options: MigrationOptions;
  hideUnmatched: boolean;
  disabled: boolean;
  onSources: (ids: string[]) => void;
  onOptions: (value: MigrationOptions) => void;
  onHideUnmatched: (value: boolean) => void;
  onApply: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [dragged, setDragged] = useState<string | null>(null);
  const drag = useRef<{
    id: string;
    pointer: number;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const selected = selectedIds.flatMap((id) => {
    const source = sources.find((source) => source.id === id);
    return source ? [source] : [];
  });
  const available = sources.filter((source) => !selectedIds.includes(source.id));
  const matches = (source: SourceLabel) =>
    `${source.name} ${source.lang}`.toLowerCase().includes(filter.trim().toLowerCase());
  const reorder = (id: string, target: string) => {
    const ids = selected.map((source) => source.id);
    const from = ids.indexOf(id);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0 || from === to || disabled) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    onSources(ids);
  };
  const stopDrag = () => {
    drag.current = null;
    setDragged(null);
  };
  const finishDrag = (event: PointerEvent<HTMLUListElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    suppressClick.current = true;
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-migration-source-id]');
    if (!disabled && !current.active && row?.dataset.migrationSourceId === current.id)
      onSources(selected.filter((source) => source.id !== current.id).map((source) => source.id));
    stopDrag();
  };
  const moveDrag = (event: PointerEvent<HTMLUListElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId || disabled) return;
    if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6)
      return;
    current.active = true;
    setDragged(current.id);
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-migration-source-id]');
    if (row && list.current?.contains(row) && row.dataset.migrationSourceId)
      reorder(current.id, row.dataset.migrationSourceId);
    if (event.clientY < 80) window.scrollBy({ top: -24 });
    else if (event.clientY > window.innerHeight - 80) window.scrollBy({ top: 24 });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && selected.length) onApply();
      }}
    >
      <h2 data-migration-stage-heading className="text-lg font-semibold tracking-tight">
        What to carry over
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Your history and reading progress on the original are always kept.
      </p>
      <div className="mt-4 overflow-hidden rounded-2xl border border-border/60 bg-surface/50">
        <fieldset className="grid sm:grid-cols-2 [&>button]:border-border/40 [&>button:not(:last-of-type)]:border-b sm:[&>button:nth-last-of-type(2)]:border-b-0 sm:[&>button:nth-of-type(odd)]:border-r">
          <legend className="sr-only">Data to carry over</legend>
          {(Object.keys(optionInfo) as Array<keyof MigrationOptions>).map((key) => {
            const { label, hint, icon: Icon } = optionInfo[key];
            return (
              <MigrationToggle
                key={key}
                label={label}
                hint={hint}
                icon={Icon}
                checked={options[key]}
                disabled={disabled}
                onToggle={() => onOptions({ ...options, [key]: !options[key] })}
              />
            );
          })}
        </fieldset>
      </div>
      <div className="mt-10 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Where to look</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick the sources to search, in order of preference. Drag a selected row, or use the
            arrow keys, to reorder.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || selected.length === sources.length}
            onClick={() =>
              onSources([
                ...selected.map((source) => source.id),
                ...available.map((source) => source.id),
              ])
            }
          >
            Select all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || !selected.length}
            onClick={() => onSources([])}
          >
            Clear
          </Button>
        </div>
      </div>
      <label className="relative mt-4 block">
        <span className="sr-only">Filter sources</span>
        <Search
          size={17}
          className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground"
        />
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          disabled={disabled}
          placeholder="Search sources…"
          className="h-11 w-full rounded-xl border border-border bg-surface/40 pl-10 pr-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        />
      </label>
      <div className="mt-4 grid items-start gap-4 md:grid-cols-2">
        <section
          className="min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-surface/40"
          aria-labelledby="migration-selected-sources"
        >
          <h3
            id="migration-selected-sources"
            className="flex items-center justify-between border-b border-border/50 px-4 py-4 text-sm font-semibold"
          >
            Selected{' '}
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {selected.length}
            </span>
          </h3>
          <ul
            ref={list}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={stopDrag}
            onLostPointerCapture={stopDrag}
            onClickCapture={(event) => {
              if (suppressClick.current && event.detail > 0) {
                suppressClick.current = false;
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            className="divide-y divide-border/40"
          >
            {selected.filter(matches).map((source) => {
              const index = selected.findIndex((entry) => entry.id === source.id);
              return (
                <li
                  key={source.id}
                  data-migration-source-id={source.id}
                  className={
                    dragged === source.id ? 'bg-primary/15 ring-1 ring-inset ring-primary/40' : ''
                  }
                >
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed="true"
                    aria-label={`Remove ${source.name} from selected sources`}
                    onClick={() =>
                      onSources(
                        selected.filter((entry) => entry.id !== source.id).map((entry) => entry.id),
                      )
                    }
                    aria-description="Drag anywhere to reorder, or use arrow up and down. Click to remove."
                    className="flex w-full touch-none select-none items-center gap-3 px-4 py-3 text-left hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary active:cursor-grabbing"
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                      event.preventDefault();
                      const target = selected[index + (event.key === 'ArrowUp' ? -1 : 1)];
                      if (target) reorder(source.id, target.id);
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !event.isPrimary || disabled) return;
                      event.preventDefault();
                      event.currentTarget.focus();
                      suppressClick.current = false;
                      list.current?.setPointerCapture(event.pointerId);
                      drag.current = {
                        id: source.id,
                        pointer: event.pointerId,
                        x: event.clientX,
                        y: event.clientY,
                        active: false,
                      };
                    }}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-xs font-medium text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{source.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {sourceLanguageName(source.lang)}
                      </span>
                    </span>
                    <GripVertical
                      size={18}
                      aria-hidden="true"
                      className="ml-auto shrink-0 text-muted-foreground"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
          {!selected.length && (
            <div className="flex min-h-36 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
              <Layers size={22} className="text-muted-foreground/50" />
              <p className="text-sm font-medium">Build your search list</p>
              <p className="max-w-56 text-xs leading-relaxed text-muted-foreground">
                Select a source from Available. Drag selected rows to set your preferred order.
              </p>
            </div>
          )}
          {selected.length > 0 && !selected.some(matches) && (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No selected sources match your filter.
            </p>
          )}
          <p className="sr-only" role="status">
            {dragged
              ? 'Reordering selected sources.'
              : selected.map((source, index) => `${index + 1}. ${source.name}`).join(', ')}
          </p>
        </section>
        <section
          className="min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-surface/40"
          aria-labelledby="migration-available-sources"
        >
          <h3
            id="migration-available-sources"
            className="flex items-center justify-between border-b border-border/50 px-4 py-4 text-sm font-semibold"
          >
            Available{' '}
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
              {available.length}
            </span>
          </h3>
          <ul className="divide-y divide-border/40">
            {available.filter(matches).map((source) => (
              <li key={source.id}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed="false"
                  aria-label={`Select ${source.name}`}
                  onClick={() => onSources([...selected.map((source) => source.id), source.id])}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
                    <Layers size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{source.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {sourceLanguageName(source.lang)}
                    </span>
                  </span>
                  <Plus size={17} className="ml-auto shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
          {!sources.length ? (
            <p role="status" className="px-4 py-6 text-sm text-muted-foreground">
              Install another source to continue.{' '}
              <Link href="/discover?tab=extensions" className="text-primary hover:underline">
                Browse extensions
              </Link>
            </p>
          ) : !available.length ? (
            <div className="flex min-h-36 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
              <Check size={22} className="text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">All sources are in your search list.</p>
            </div>
          ) : (
            !available.some(matches) && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No available sources match your filter.
              </p>
            )
          )}
        </section>
      </div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-border/60 bg-surface/50">
        <MigrationToggle
          label="Hide sources without a match"
          hint="Leave out source sections that finish searching with no results."
          checked={hideUnmatched}
          disabled={disabled}
          onToggle={() => onHideUnmatched(!hideUnmatched)}
        />
      </div>
      <div className="sticky bottom-0 z-20 mt-6 flex items-center justify-between gap-3 border-t border-border/60 bg-background/95 py-4 backdrop-blur">
        <div>
          <p className="text-sm font-medium">
            {selected.length
              ? `${selected.length} source${selected.length === 1 ? '' : 's'} selected`
              : 'No sources selected'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {selected.length
              ? 'Searches run in the order shown.'
              : 'Select at least one source to search.'}
          </p>
        </div>
        <Button
          type="submit"
          disabled={disabled || !selected.length}
          className="h-11 gap-2 sm:min-w-40"
        >
          Apply
          <ArrowRight size={16} />
        </Button>
      </div>
    </form>
  );
}

function MigrationSearchCard({
  item,
  source,
  onChoose,
  onInspect,
}: {
  item: Mangas;
  source: SourceLabel;
  onChoose: (item: Mangas) => void;
  onInspect: (item: Mangas) => void;
}) {
  const hold = useHoldToSelect({ onSelect: () => onInspect(item) });
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Select ${item.title} from ${source.name}`}
      aria-description="Hold or press Space to view details. Click or press Enter to choose for migration."
      {...hold}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onChoose(item);
        } else hold.onKeyDown(event);
      }}
      onClick={() => onChoose(item)}
      onDragStart={(event) => event.preventDefault()}
      className="group block w-full cursor-pointer select-none rounded-xl text-left focus-visible:outline-2 focus-visible:outline-primary"
    >
      <Cover
        sourceId={item.source}
        src={item.thumbnail_url ? buildImageProxyUrl(item.thumbnail_url, item.source) : null}
        alt=""
        className="aspect-[2/3] w-full transition group-hover:brightness-110"
      />
      <span
        title={item.title}
        className="mt-2 block truncate text-sm font-medium group-hover:text-primary"
      >
        {item.title}
      </span>
    </div>
  );
}

function MigrationResultRail({
  source,
  rows,
  onChoose,
  onInspect,
  initialScroll,
}: {
  source: SourceLabel;
  rows: Mangas[];
  onChoose: (item: Mangas) => void;
  onInspect: (item: Mangas) => void;
  initialScroll: number;
}) {
  const rail = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = () => {
    const element = rail.current;
    if (element)
      setEdges({
        left: element.scrollLeft > 1,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
  };
  useEffect(() => {
    if (rail.current) rail.current.scrollLeft = initialScroll;
  }, [initialScroll]);
  useEffect(() => {
    updateEdges();
    window.addEventListener('resize', updateEdges);
    return () => window.removeEventListener('resize', updateEdges);
  }, [rows.length]);
  const move = (direction: number) =>
    rail.current?.scrollBy({
      left: direction * rail.current.clientWidth * 0.8,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-base font-semibold">{source.name}</h3>
          <span className="shrink-0 text-xs text-muted-foreground">
            {sourceLanguageName(source.lang)} · {rows.length} result{rows.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!edges.left}
            aria-label={`Previous results from ${source.name}`}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={18} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!edges.right}
            aria-label={`Next results from ${source.name}`}
            onClick={() => move(1)}
          >
            <ChevronRight size={18} />
          </Button>
        </div>
      </div>
      <ul
        ref={rail}
        data-migration-result-source={source.id}
        tabIndex={0}
        aria-label={`Manga results from ${source.name}`}
        onScroll={updateEdges}
        className="flex snap-x snap-proximity gap-4 overflow-x-auto pb-3 focus-visible:outline-2 focus-visible:outline-primary"
      >
        {rows.map((item) => (
          <li key={`${item.source}:${item.id}`} className="w-32 shrink-0 snap-start sm:w-36">
            <MigrationSearchCard
              item={item}
              source={source}
              onChoose={onChoose}
              onInspect={onInspect}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

export function MigrationMatchesStage({
  results,
  sources,
  status,
  query,
  hideUnmatched,
  disabled,
  onQuery,
  onSearch,
  onChoose,
  onInspect,
  railScrolls,
  onEdit,
  onRetry,
  onResume,
}: {
  results: Mangas[];
  sources: SourceLabel[];
  status: MigrationSearchStatus;
  query: string;
  hideUnmatched: boolean;
  disabled: boolean;
  onQuery: (value: string) => void;
  onSearch: () => void;
  onChoose: (item: Mangas) => void;
  onInspect: (item: Mangas) => void;
  railScrolls: Record<string, number>;
  onEdit: () => void;
  onRetry: () => void;
  onResume: () => void;
}) {
  const visible = results.filter((item) => sources.some((source) => source.id === item.source));
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 data-migration-stage-heading className="text-xl font-semibold">
            Find the replacement
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the matching title. Hold a cover, or press Space, to preview it first.
          </p>
        </div>
        <Button variant="outline" onClick={onEdit}>
          Edit sources &amp; data
        </Button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim() && !disabled) onSearch();
        }}
        className="relative mt-5 flex items-center gap-2 rounded-full border border-border bg-surface/60 p-1.5 pl-4 focus-within:ring-2 focus-within:ring-primary/30"
      >
        <Search size={19} className="shrink-0 text-muted-foreground" />
        <input
          type="search"
          aria-label="Search manga for migration"
          placeholder="Search manga…"
          value={query}
          disabled={disabled}
          onChange={(event) => onQuery(event.target.value)}
          className="h-9 min-w-0 flex-1 bg-transparent px-2 text-sm outline-none"
        />
        <Button type="submit" disabled={disabled || !query.trim()} className="rounded-full px-5">
          Search
        </Button>
      </form>
      <div
        role="status"
        className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        {status.state === 'searching' && (
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
        )}
        <span>
          {status.settled.length} of {status.sourceIds.length} sources searched
        </span>
        {status.failed.length > 0 && (
          <span className="text-destructive">· {status.failed.length} unavailable</span>
        )}
        {status.state === 'paused' && status.settled.length < status.sourceIds.length && (
          <span>· Search paused</span>
        )}
      </div>
      <div className="mt-7 space-y-6">
        {sources.map((source) => {
          const rows = visible.filter((item) => item.source === source.id);
          const settled = status.settled.includes(source.id);
          const failed = status.failed.includes(source.id);
          if (hideUnmatched && settled && !failed && !rows.length) return null;
          return (
            <section
              key={source.id}
              className="min-w-0 border-b border-border/40 pb-6 last:border-0"
            >
              {rows.length ? (
                <>
                  <MigrationResultRail
                    source={source}
                    rows={rows}
                    onChoose={onChoose}
                    onInspect={onInspect}
                    initialScroll={railScrolls[source.id] ?? 0}
                  />
                  {failed && (
                    <p className="mt-2 text-xs text-destructive">
                      This source could not be refreshed. Earlier matches are retained; retry
                      unavailable sources below.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h3 className="text-base font-semibold">
                    {source.name}{' '}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {sourceLanguageName(source.lang)}
                    </span>
                  </h3>
                  <div
                    className={`mt-3 flex items-center gap-2 rounded-xl border border-dashed p-5 text-sm ${failed ? 'border-destructive/30 text-destructive' : 'border-border text-muted-foreground'}`}
                  >
                    {failed ? (
                      <>
                        <AlertCircle size={16} />
                        This source could not be searched.
                      </>
                    ) : settled ? (
                      'No matching manga found.'
                    ) : status.state === 'searching' ? (
                      <>
                        <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
                        Searching…
                      </>
                    ) : (
                      'Search paused. Resume to search this source.'
                    )}
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
      {!visible.length && status.state !== 'searching' && (
        <p className="mt-6 text-sm text-muted-foreground">
          {status.failed.length === status.sourceIds.length && status.failed.length
            ? 'Sources are unavailable. Retry or choose other sources.'
            : 'No matching manga found. Try another title or change the selected sources.'}
        </p>
      )}
      {status.state !== 'searching' && (
        <div className="mt-6 flex flex-wrap gap-3">
          {status.state === 'paused' && status.settled.length < status.sourceIds.length && (
            <Button variant="outline" onClick={onResume}>
              Search remaining sources
            </Button>
          )}
          {(status.failed.length > 0 || !visible.length) && (
            <Button
              variant="outline"
              disabled={disabled || !status.sourceIds.length}
              onClick={onRetry}
            >
              <RefreshCw size={14} className="mr-2" />
              {status.failed.length ? 'Retry unavailable sources' : 'Retry search'}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

export function MigrationReviewStage({
  manga,
  originalSource,
  replacementSource,
  selected,
  details,
  originalCount,
  preview,
  matchedCount,
  originalReadCount,
  options,
  transfer,
  error,
  onBack,
  onEdit,
  onRetryPreview,
  onMigrate,
}: {
  manga: Manga;
  originalSource: string;
  replacementSource: string;
  selected: Mangas;
  details: MangaDetails | null;
  originalCount: number | null;
  preview: MigrationPreviewStatus;
  matchedCount: number;
  originalReadCount: number;
  options: MigrationOptions;
  transfer: MigrationTransferStatus;
  error: string;
  onBack: () => void;
  onEdit: () => void;
  onRetryPreview: () => void;
  onMigrate: () => void;
}) {
  const saving = transfer.state === 'saving';
  const thumbnail = details?.thumbnail_url || selected.thumbnail_url;
  if (transfer.state === 'success')
    return (
      <section className="rounded-2xl border border-border/60 bg-surface/50 px-6 py-12 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/15 text-primary">
          <Check size={24} />
        </div>
        <h2 tabIndex={-1} data-migration-outcome className="mt-4 text-2xl font-semibold">
          Migration complete
        </h2>
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Your selected data is now available on {replacementSource}. The original was removed from
          your library and its downloads were deleted. Its history and progress are retained.
        </p>
        <Button asChild className="mt-6 h-11">
          <Link href={`/manga/${encodeURIComponent(transfer.targetId)}`}>
            Open migrated title
            <ArrowRight size={16} className="ml-2" />
          </Link>
        </Button>
      </section>
    );
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 data-migration-stage-heading className="text-xl font-semibold">
            Review and migrate
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Confirm the replacement and the data you want to keep.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" disabled={saving} aria-label="Migration options">
              <MoreVertical size={20} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem disabled={saving || preview !== 'ready'} onSelect={onMigrate}>
              <ArrowRight />
              {transfer.state === 'partial' ? 'Retry remaining transfers' : 'Migrate'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={saving} onSelect={onBack}>
              <Search />
              Change match
            </DropdownMenuItem>
            <DropdownMenuItem disabled={saving} onSelect={onEdit}>
              <Layers />
              Edit sources &amp; data
            </DropdownMenuItem>
            {preview === 'error' && (
              <DropdownMenuItem onSelect={onRetryPreview}>
                <RefreshCw />
                Retry comparison
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={`/manga/${encodeURIComponent(manga.id)}`}>View original manga</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link
                href={`/discover/preview/${encodeURIComponent(selected.source)}/${encodeURIComponent(selected.id)}`}
              >
                View replacement manga
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-3 rounded-2xl border border-border/60 bg-surface/50 p-4 sm:gap-6 sm:p-6">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:gap-4">
          <Cover
            sourceId={manga.source}
            src={manga.thumbnailUrl}
            alt=""
            className="aspect-[2/3] w-[72px] shrink-0 sm:w-24"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              From
            </p>
            <h3 title={manga.title} className="mt-2 truncate text-sm font-semibold sm:text-base">
              {manga.title}
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">{originalSource}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {originalCount ?? manga.chapters} chapters
            </p>
          </div>
        </div>
        <span className="grid size-8 self-center place-items-center rounded-full border border-border bg-background sm:size-10">
          <ArrowRight size={18} className="text-primary" aria-label="Migrates to" />
        </span>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:gap-4">
          <Cover
            sourceId={selected.source}
            src={thumbnail ? buildImageProxyUrl(thumbnail, selected.source) : null}
            alt=""
            className="aspect-[2/3] w-[72px] shrink-0 sm:w-24"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-widest text-primary">To</p>
            <h3
              title={details?.title ?? selected.title}
              className="mt-2 truncate text-sm font-semibold sm:text-base"
            >
              {details?.title ?? selected.title}
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">{replacementSource}</p>
            {details && (
              <p className="mt-1 text-xs text-muted-foreground">
                {details.chapters.length} chapters
              </p>
            )}
          </div>
        </div>
      </div>
      {preview === 'loading' && (
        <div
          role="status"
          className="mt-6 flex items-center gap-2 rounded-xl border border-border p-5 text-sm text-muted-foreground"
        >
          <Loader2 size={18} className="animate-spin motion-reduce:animate-none" />
          Loading chapter comparison…
        </div>
      )}
      {preview === 'error' && (
        <div role="alert" className="mt-6 rounded-xl border border-destructive/30 p-5 text-sm">
          <p>{error}</p>
          <Button variant="outline" className="mt-3" onClick={onRetryPreview}>
            Retry comparison
          </Button>
        </div>
      )}
      {details && preview === 'ready' && (
        <>
          <section className="mt-6 rounded-xl border border-border/60 p-4">
            <h3 className="text-sm font-semibold">Transfer summary</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {(Object.keys(optionInfo) as Array<keyof MigrationOptions>)
                .filter((key) => options[key])
                .map((key) => (
                  <span key={key} className="rounded-full bg-secondary px-3 py-1 text-xs">
                    {optionInfo[key].label}
                  </span>
                ))}
              {!Object.values(options).some(Boolean) && (
                <span className="text-xs text-muted-foreground">
                  Add the replacement title without copying extra data.
                </span>
              )}
            </div>
            {options.read && (
              <p className="mt-3 text-xs text-muted-foreground">
                {originalReadCount === 0
                  ? "You haven't finished any chapters of the original yet, so there is no completed progress to carry over."
                  : `${matchedCount} replacement chapter${matchedCount === 1 ? '' : 's'} will keep completed progress from ${originalReadCount} read chapter${originalReadCount === 1 ? '' : 's'}. Chapters absent from the replacement are skipped.`}
              </p>
            )}
            {(originalCount ?? manga.chapters) > details.chapters.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                The replacement lists {(originalCount ?? manga.chapters) - details.chapters.length}{' '}
                fewer chapter
                {(originalCount ?? manga.chapters) - details.chapters.length === 1 ? '' : 's'} than
                the original. Different scanlation groups and split chapters often account for this.
              </p>
            )}
          </section>
          {transfer.state === 'partial' && (
            <div
              role="alert"
              className="mt-5 flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
            >
              <AlertCircle size={18} className="shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-semibold">Some data still needs to transfer</p>
                <p className="mt-1 text-xs text-muted-foreground">{transfer.message}</p>
              </div>
            </div>
          )}
          <div className="sticky bottom-0 z-20 mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background/95 py-4 backdrop-blur">
            <p role="status" className="text-xs text-muted-foreground">
              {saving
                ? transfer.label
                : 'The original leaves your library and its downloads are removed after migration.'}
            </p>
            <Button
              disabled={saving}
              onClick={onMigrate}
              className="h-11 w-full gap-2 sm:w-auto sm:min-w-40"
            >
              {saving ? (
                <>
                  <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
                  Migrating…
                </>
              ) : transfer.state === 'partial' ? (
                'Retry remaining transfers'
              ) : (
                <>
                  Migrate
                  <ArrowRight size={16} />
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
