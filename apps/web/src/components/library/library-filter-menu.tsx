'use client';

import { useMemo } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  LIBRARY_STATUSES,
  NO_LIBRARY_FILTERS,
  cycleTag,
  libraryFilterCount,
  libraryTags,
  type LibraryFilters,
} from '@/lib/library-filters';
import type { Manga } from '@/lib/manga-data';

const CHIP = 'rounded-full border px-2.5 py-1 text-xs pointer-coarse:min-h-9 transition';
const CHIP_OFF = 'border-border/60 text-muted-foreground hover:text-foreground';
const CHIP_ON = 'border-primary/50 bg-primary/10 text-primary';
const CHIP_EXCLUDED = 'border-destructive/50 bg-destructive/10 text-destructive line-through';

/** Publication status and tags, from what's actually in the library. */
export function LibraryFilterMenu({
  library,
  filters,
  onChange,
}: {
  library: Manga[];
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
}) {
  const tags = useMemo(() => libraryTags(library), [library]);
  const active = libraryFilterCount(filters);
  const toggleStatus = (status: Manga['status']) =>
    onChange({
      ...filters,
      statuses: filters.statuses.includes(status)
        ? filters.statuses.filter((entry) => entry !== status)
        : [...filters.statuses, status],
    });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={active > 0 ? `Filters, ${active} active` : 'Filters'}
          title="Filter by status and tag"
          className={`relative grid h-9 w-9 place-items-center rounded-lg border transition ${
            active > 0
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-border/60 text-muted-foreground hover:text-foreground'
          }`}
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-80 overflow-y-auto">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Filters</h2>
          <button
            type="button"
            disabled={active === 0}
            onClick={() => onChange(NO_LIBRARY_FILTERS)}
            className="text-xs text-primary disabled:opacity-50"
          >
            Clear
          </button>
        </div>

        <h3 className="mt-3 text-xs font-medium text-muted-foreground">Status</h3>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {LIBRARY_STATUSES.map((status) => {
            const on = filters.statuses.includes(status);
            return (
              <button
                key={status}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(status)}
                className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
              >
                {status}
              </button>
            );
          })}
        </div>

        <h3 className="mt-3 text-xs font-medium text-muted-foreground">Tags</h3>
        {tags.length === 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">No tags in your library yet.</p>
        ) : (
          <>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Press once to require a tag, again to exclude it.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tags.map((tag) => {
                const included = filters.includeTags.includes(tag);
                const excluded = filters.excludeTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    aria-label={`${tag}: ${included ? 'required' : excluded ? 'excluded' : 'any'}`}
                    onClick={() => onChange(cycleTag(filters, tag))}
                    className={`${CHIP} ${included ? CHIP_ON : excluded ? CHIP_EXCLUDED : CHIP_OFF}`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
