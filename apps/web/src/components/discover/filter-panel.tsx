'use client';

import { useEffect, useId, useState } from 'react';
import type { MangaFilter } from '@projekt-manga/types';
import type { FilterValue, TriStateFilterValue } from '@projekt-manga/types';
import { countActiveFilters, isTriState, type FilterValues } from '@/lib/filter-values';
import { RotateCcw } from 'lucide-react';

function cycleTriStateOption(
  current: FilterValue | undefined,
  option: string,
): FilterValue | undefined {
  const base: TriStateFilterValue = isTriState(current) ? current : {};
  const include = base.include ?? [];
  const exclude = base.exclude ?? [];

  let next: TriStateFilterValue;
  if (include.includes(option)) {
    next = { include: include.filter((v) => v !== option), exclude: [...exclude, option] };
  } else if (exclude.includes(option)) {
    next = { include, exclude: exclude.filter((v) => v !== option) };
  } else {
    next = { include: [...include, option], exclude };
  }

  return (next.include?.length ?? 0) > 0 || (next.exclude?.length ?? 0) > 0 ? next : undefined;
}

/** Uniform shell for one filter: label above, control below. Keeps a 38-option tag list
 * and a single dropdown from producing wildly different row heights. */
function FilterSection({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  // aria-labelledby names the group for screen readers (tag filters are rows of up to 38
  // pills). The form controls below also carry their own aria-label, because a group name
  // is not an accessible name for the control inside it.
  const labelId = useId();
  return (
    <section aria-labelledby={labelId}>
      <div className="mb-2 flex items-baseline gap-2">
        <span id={labelId} className="text-xs font-semibold text-foreground">
          {label}
        </span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const PILL_BASE =
  'rounded-full border px-3 py-1.5 text-xs leading-none transition whitespace-nowrap max-w-full';

/** Options shown before a group collapses. Tag groups run to ~40 entries on some
 * sources, which would otherwise bury every filter below them. */
const COLLAPSED_LIMIT = 12;

/**
 * Renders a group of option pills directly on the panel — no inner container. Large
 * groups collapse to a preview with a "+N more" toggle rather than scrolling inside a
 * box, so the panel stays scannable no matter how many options a source publishes.
 */
function PillGroup<T>({
  options,
  isSelected,
  renderPill,
}: {
  options: T[];
  /** Selected options are pinned into the collapsed preview — otherwise a choice made
   * while expanded would vanish from view the moment the group collapsed again. */
  isSelected: (option: T) => boolean;
  renderPill: (option: T) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  if (options.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No options available.</p>;
  }

  const visible = expanded
    ? options
    : [...options.filter(isSelected), ...options.filter((o) => !isSelected(o))].slice(
        0,
        COLLAPSED_LIMIT,
      );
  const hiddenCount = options.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {visible.map((option) => renderPill(option))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={`${PILL_BASE} border-dashed border-border/70 bg-transparent text-muted-foreground hover:text-foreground`}
        >
          +{hiddenCount} more
        </button>
      )}
      {expanded && options.length > COLLAPSED_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className={`${PILL_BASE} border-dashed border-border/70 bg-transparent text-muted-foreground hover:text-foreground`}
        >
          Show less
        </button>
      )}
    </div>
  );
}

export function FilterPanel({
  fields,
  values,
  onApply,
}: {
  fields: MangaFilter[];
  /** Currently applied values — the draft resets to these whenever they change. */
  values: FilterValues;
  onApply: (next: FilterValues) => void;
}) {
  // Edits stay local until Apply: every keystroke/pill hitting the network would mean a
  // scrape request per change, and the result set jumping around mid-selection.
  const [draft, setDraft] = useState<FilterValues>(values);
  useEffect(() => setDraft(values), [values]);

  const set = (key: string, value: FilterValue | undefined) =>
    setDraft((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  const dirty = JSON.stringify(draft) !== JSON.stringify(values);
  const activeCount = countActiveFilters(draft);

  if (fields.length === 0) return null;

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Filters{activeCount > 0 && ` · ${activeCount} active`}
        </span>
        <button
          onClick={() => setDraft({})}
          disabled={activeCount === 0}
          className="flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" /> Clear all
        </button>
      </div>

      {/* The panel itself scrolls once expanded groups make it tall — that's a bound on
          the whole sheet, not a box around any individual pill group. */}
      <div className="grid max-h-[30rem] grid-cols-1 gap-x-8 gap-y-6 overflow-y-auto p-4 md:grid-cols-2">
        {fields.map((field) => {
          const value = draft[field.value];

          if (field.type === 'tri-state') {
            const tri = isTriState(value) ? value : {};
            return (
              <FilterSection
                key={field.value}
                label={field.label}
                hint="click: include · again: exclude"
              >
                <PillGroup
                  options={field.options ?? []}
                  isSelected={(o) =>
                    Boolean(tri.include?.includes(o.value) || tri.exclude?.includes(o.value))
                  }
                  renderPill={(o) => {
                    const included = tri.include?.includes(o.value);
                    const excluded = tri.exclude?.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => set(field.value, cycleTriStateOption(value, o.value))}
                        className={`${PILL_BASE} ${
                          included
                            ? 'border-primary/60 bg-primary/15 text-primary'
                            : excluded
                              ? 'border-destructive/60 bg-destructive/15 text-destructive line-through'
                              : 'border-border/60 bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  }}
                />
              </FilterSection>
            );
          }

          if (field.type === 'multi' || field.type === 'checkbox' || field.type === 'radio') {
            const selected = Array.isArray(value) ? value : [];
            return (
              <FilterSection key={field.value} label={field.label}>
                <PillGroup
                  options={field.options ?? []}
                  isSelected={(o) => selected.includes(o.value)}
                  renderPill={(o) => {
                    const on = selected.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => {
                          const next = on
                            ? selected.filter((x) => x !== o.value)
                            : [...selected, o.value];
                          set(field.value, next.length > 0 ? next : undefined);
                        }}
                        className={`${PILL_BASE} ${
                          on
                            ? 'border-primary/60 bg-primary/15 text-primary'
                            : 'border-border/60 bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  }}
                />
              </FilterSection>
            );
          }

          if (field.type === 'select') {
            return (
              <FilterSection key={field.value} label={field.label}>
                <select
                  aria-label={field.label}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => set(field.value, e.target.value || undefined)}
                  className="h-9 w-full rounded-lg border border-border/60 bg-background px-2 text-xs text-foreground outline-none focus:border-primary/60"
                >
                  <option value="">Any</option>
                  {(field.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FilterSection>
            );
          }

          return (
            <FilterSection key={field.value} label={field.label}>
              <input
                aria-label={field.label}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => set(field.value, e.target.value || undefined)}
                className="h-9 w-full rounded-lg border border-border/60 bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary/60 placeholder:text-muted-foreground"
              />
            </FilterSection>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-border/50 px-4 py-3">
        {dirty && (
          <span className="mr-auto text-[11px] text-muted-foreground">Unapplied changes</span>
        )}
        <button
          onClick={() => setDraft(values)}
          disabled={!dirty}
          className="text-xs text-muted-foreground transition hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          onClick={() => onApply(draft)}
          disabled={!dirty}
          className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-glow transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
        >
          Apply filters
        </button>
      </div>
    </div>
  );
}
