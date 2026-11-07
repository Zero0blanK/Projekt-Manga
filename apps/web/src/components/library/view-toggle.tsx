import { actions, useAppState } from '@/lib/app-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Grid3x3, LayoutGrid, List } from 'lucide-react';

const VIEWS = [
  { value: 'grid', label: 'Grid', icon: LayoutGrid },
  { value: 'compact', label: 'Compact', icon: Grid3x3 },
  { value: 'list', label: 'List', icon: List },
] as const;

/** One button showing the current layout; the others are in its menu. */
export function ViewToggle() {
  const view = useAppState((s) => s.view);
  const current = VIEWS.find((option) => option.value === view) ?? VIEWS[0];
  const CurrentIcon = current.icon;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`Library view: ${current.label}`}
        title="Library view"
        className="grid h-9 w-9 place-items-center rounded-lg border border-border/60 text-muted-foreground transition hover:text-foreground"
      >
        <CurrentIcon className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        {VIEWS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            aria-current={value === current.value ? 'true' : undefined}
            onSelect={() => actions.setView(value)}
            className={`gap-2 text-xs ${value === current.value ? 'text-primary' : ''}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
