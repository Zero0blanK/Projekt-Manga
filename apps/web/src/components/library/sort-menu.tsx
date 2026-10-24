import { useState } from 'react';
import { actions, useAppState } from '@/lib/app-store';
import { sorts } from '@/components/library/constants';
import { SortDirectionIcon } from '@/components/sort-direction-toggle';
import { ArrowUpDown } from 'lucide-react';

export function SortMenu() {
  const sort = useAppState((s) => s.sort);
  const sortDir = useAppState((s) => s.sortDir);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowUpDown className="h-3.5 w-3.5" /> {sorts.find((s) => s.value === sort)?.label}
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close sort menu"
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-11 z-20 w-48 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-lg">
            {sorts.map((s) => {
              const active = sort === s.value;
              return (
                <button
                  key={s.value}
                  onClick={() => {
                    if (active) actions.setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
                    else {
                      actions.setSort(s.value);
                      actions.setSortDir('desc');
                    }
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition hover:bg-accent ${
                    active ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {s.label}
                  {active && <SortDirectionIcon direction={sortDir} />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
