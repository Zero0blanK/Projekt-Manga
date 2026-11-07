import { actions, useAppState } from '@/lib/app-store';
import { Grid3x3, LayoutGrid, List } from 'lucide-react';

export function ViewToggle() {
  const view = useAppState((s) => s.view);

  return (
    <>
      <button
        type="button"
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
        type="button"
        onClick={() => actions.setView('compact')}
        aria-label="Compact grid view"
        aria-pressed={view === 'compact'}
        className={`grid h-9 w-9 place-items-center rounded-lg border transition ${
          view === 'compact'
            ? 'border-primary/50 bg-primary/10 text-primary'
            : 'border-border/60 text-muted-foreground hover:text-foreground'
        }`}
      >
        <Grid3x3 className="h-4 w-4" />
      </button>
      <button
        type="button"
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
