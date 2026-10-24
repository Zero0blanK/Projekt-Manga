import { actions, useSetting, PAGE_LAYOUTS } from '@/lib/app-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Settings2 } from 'lucide-react';

export function ReaderSettingsMenu() {
  const layout = useSetting('pageLayout', 'Two-page spread') as string;

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
            onSelect={() => actions.setSetting('pageLayout', l)}
            className={l === layout ? 'text-primary' : ''}
          >
            {l}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
