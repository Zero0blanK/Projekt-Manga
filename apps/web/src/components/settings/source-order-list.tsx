'use client';

import { useState } from 'react';
import { GripVertical, Plus, Search, X } from 'lucide-react';
import { useDragReorder } from '@/hooks/use-drag-reorder';
import { sourceLanguageName } from '@/lib/source-language';

type SourceLabel = { id: string; name: string; lang: string };

/**
 * An ordered pick of installed sources, sized for a dialog: drag a row (or use the arrow
 * keys on it) to reorder, the cross to remove, and the list below to add one.
 */
export function SourceOrderList({
  sources,
  value,
  onChange,
  disabled,
  label,
}: {
  sources: SourceLabel[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** Names the list for assistive technology, e.g. "Search order for Asura Scans". */
  label: string;
}) {
  const selected = value.flatMap((id) => {
    const source = sources.find((source) => source.id === id);
    return source ? [source] : [];
  });
  const available = sources.filter((source) => !value.includes(source.id));
  const ids = selected.map((source) => source.id);
  const [filter, setFilter] = useState('');
  const matches = (source: SourceLabel) =>
    `${source.name} ${source.lang}`.toLowerCase().includes(filter.trim().toLowerCase());
  const order = useDragReorder<HTMLOListElement>({ ids, onReorder: onChange, disabled });

  const reorder = (id: string, target: string) => {
    const from = ids.indexOf(id);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0 || disabled) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, id);
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      {selected.length > 0 && (
        <ol ref={order.listRef} aria-label={label} className="space-y-1">
          {selected.map((source, index) => (
            <li
              key={source.id}
              data-drag-id={source.id}
              style={order.itemStyle(source.id)}
              className={`flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs ${
                order.dragging === source.id
                  ? 'border-primary/60 ring-1 ring-primary/30'
                  : 'border-border/60'
              }`}
            >
              <button
                type="button"
                disabled={disabled}
                aria-label={`Move ${source.name}, number ${index + 1}`}
                aria-description="Drag, or press arrow up and down, to reorder."
                className="flex min-w-0 flex-1 touch-none select-none items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 enabled:cursor-grab enabled:active:cursor-grabbing"
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  const target = ids[index + (event.key === 'ArrowUp' ? -1 : 1)];
                  if (target) reorder(source.id, target);
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || disabled) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  order.start(source.id, event);
                }}
              >
                <GripVertical
                  size={14}
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground"
                />
                <span className="grid size-5 shrink-0 place-items-center rounded bg-secondary text-[10px] font-medium text-muted-foreground">
                  {order.position(source.id) + 1}
                </span>
                <span className="truncate font-medium">{source.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {sourceLanguageName(source.lang)}
                </span>
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${source.name}`}
                onClick={() => onChange(ids.filter((id) => id !== source.id))}
                className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {available.length > 0 && (
        <div className="overflow-hidden rounded-md border border-dashed border-border/70">
          <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5">
            <Search size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={filter}
              disabled={disabled}
              onChange={(event) => setFilter(event.target.value)}
              aria-label={`Filter sources to add to ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
              placeholder={selected.length ? 'Then try…' : 'Add a source…'}
              className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul className="max-h-44 divide-y divide-border/40 overflow-y-auto">
            {available.filter(matches).map((source) => (
              <li key={source.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate">{source.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {sourceLanguageName(source.lang)}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Add ${source.name}`}
                  onClick={() => onChange([...ids, source.id])}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  <Plus size={12} aria-hidden="true" />
                  Add
                </button>
              </li>
            ))}
            {!available.some(matches) && (
              <li className="px-2 py-2 text-xs text-muted-foreground">No sources match.</li>
            )}
          </ul>
        </div>
      )}
      <p className="sr-only" role="status">
        {selected.map((source, index) => `${index + 1}. ${source.name}`).join(', ')}
      </p>
    </div>
  );
}
