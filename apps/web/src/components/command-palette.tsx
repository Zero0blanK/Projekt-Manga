'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  CalendarDays,
  Compass,
  Download,
  History,
  Library,
  RefreshCw,
  Settings,
  Shuffle,
  Sparkles,
  VenetianMask,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useMangaLibrary } from '@/lib/library-store';
import { useUpdateLibrary } from '@/components/library/update-library-button';
import { SETTINGS_SECTIONS } from '@/components/settings/settings-nav';
import { goToAppPath } from '@/lib/app-navigation';
import { setAppIncognito, useAppIncognito } from '@/lib/incognito';

/** Opens the palette from elsewhere (the desktop app menu). */
export const OPEN_COMMAND_PALETTE = 'projekt-manga:command-palette';
export const openCommandPalette = () => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE));

const PAGES = [
  { label: 'Library', href: '/', icon: Library },
  { label: 'Discover', href: '/discover', icon: Compass },
  { label: 'History', href: '/history', icon: History },
  { label: 'Downloads', href: '/downloads', icon: Download },
  { label: 'Upcoming releases', href: '/upcoming', icon: CalendarDays },
  { label: 'Year in manga', href: '/year', icon: Sparkles },
  { label: 'Settings', href: '/settings', icon: Settings },
];

/**
 * Ctrl+Shift+P (Cmd+Shift+P): jump to a library title, a page or a settings section, or
 * run an action. Not Ctrl+K, which already focuses the search box. In the desktop app the
 * menu owns the key and opens this through the event above; in a browser it is caught
 * here.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { manga } = useMangaLibrary();
  const { updateLibrary, running, titleCount } = useUpdateLibrary();
  const incognito = useAppIncognito();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'p'
      ) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    const show = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE, show);
    };
  }, []);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search titles, pages, settings…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem
            disabled={running || titleCount === 0}
            onSelect={() => run(() => void updateLibrary())}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> Update library
          </CommandItem>
          <CommandItem onSelect={() => run(() => setAppIncognito(!incognito))}>
            <VenetianMask className="mr-2 h-4 w-4" />{' '}
            {incognito ? 'Turn incognito off' : 'Turn incognito on'}
          </CommandItem>
          {manga.length > 0 && (
            <CommandItem
              onSelect={() =>
                run(() => {
                  const pick = manga[Math.floor(Math.random() * manga.length)];
                  router.push(`/manga/${encodeURIComponent(pick.id)}`);
                })
              }
            >
              <Shuffle className="mr-2 h-4 w-4" /> Random library title
            </CommandItem>
          )}
        </CommandGroup>
        <CommandGroup heading="Go to">
          {PAGES.map(({ label, href, icon: Icon }) => (
            <CommandItem
              key={href}
              value={`page ${label}`}
              onSelect={() => run(() => router.push(href))}
            >
              <Icon className="mr-2 h-4 w-4" /> {label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Settings">
          {SETTINGS_SECTIONS.map(({ id, label }) => (
            <CommandItem
              key={id}
              value={`settings ${label} ${id}`}
              onSelect={() => run(() => goToAppPath(router, `/settings#${id}`))}
            >
              <Settings className="mr-2 h-4 w-4" /> {label} settings
            </CommandItem>
          ))}
        </CommandGroup>
        {manga.length > 0 && (
          <CommandGroup heading="Library">
            {manga.map((title) => (
              <CommandItem
                key={title.id}
                value={`title ${title.title} ${title.id}`}
                onSelect={() => run(() => router.push(`/manga/${encodeURIComponent(title.id)}`))}
              >
                <BookOpen className="mr-2 h-4 w-4" /> {title.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
