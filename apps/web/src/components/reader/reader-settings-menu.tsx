import { actions, useSetting, PAGE_LAYOUTS } from '@/lib/app-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Settings2 } from 'lucide-react';

/**
 * The reader header's page-layout menu. Picking a layout changes the global setting,
 * unless `onChooseLayout` handles the choice (returns true) — e.g. saving it for this
 * title when a webtoon was switched to the long strip automatically.
 */
export function ReaderSettingsMenu({
  onChooseLayout,
  currentLayout,
}: {
  onChooseLayout?: (layout: string) => boolean;
  /** The layout shown, when it differs from the global setting. */
  currentLayout?: string;
} = {}) {
  const globalLayout = useSetting('pageLayout', 'Two-page spread') as string;
  const layout = currentLayout ?? globalLayout;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Reader settings"
        className="grid h-9 w-9 place-items-center rounded-lg text-white/70 transition hover:bg-white/5 hover:text-white"
      >
        <Settings2 className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {PAGE_LAYOUTS.map((l) => (
          <DropdownMenuItem
            key={l}
            onSelect={() => {
              if (onChooseLayout?.(l)) return;
              actions.setSetting('pageLayout', l);
            }}
            className={l === layout ? 'text-primary' : ''}
          >
            {l}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
