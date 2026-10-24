import { actions, useAppState } from '@/lib/app-store';
import { LayoutGrid, List } from 'lucide-react';

export function ViewToggle() {
  const view = useAppState((s) => s.view);

  return (
    <>
      <button
        onClick={() => actions.setView('grid')}
        aria-label="Grid view"
        aria-pressed={view === 'grid'}
        className={`grid h-9 w-9 place-items-center rounded-lg border transition ${
          view === 'grid'
            ? 'border-primary/50 bg-primary/10 text-primary'
            : 'border-border/60 text-muted-foreground hover:text-foreground'
        }`}
      >
        <LayoutGrid className="h-4 w-4" />
      </button>
      <button
        onClick={() => actions.setView('list')}
        aria-label="List view"
        aria-pressed={view === 'list'}
        className={`grid h-9 w-9 place-items-center rounded-lg border transition ${
          view === 'list'
            ? 'border-primary/50 bg-primary/10 text-primary'
            : 'border-border/60 text-muted-foreground hover:text-foreground'
        }`}
      >
        <List className="h-4 w-4" />
      </button>
    </>
  );
}
