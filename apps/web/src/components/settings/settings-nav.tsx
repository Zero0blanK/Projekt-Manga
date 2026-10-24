import { useEffect, useRef } from 'react';
import {
  User,
  Palette,
  BookOpen,
  BarChart3,
  Bell,
  Cloud,
  Keyboard,
  Shield,
  Info,
  ScrollText,
  Puzzle,
} from 'lucide-react';

const sections = [
  { id: 'account', label: 'Profile', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'reader', label: 'Reader', icon: BookOpen },
  { id: 'extensions', label: 'Extensions', icon: Puzzle },
  { id: 'statistics', label: 'Statistics', icon: BarChart3 },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'sync', label: 'Sync & Storage', icon: Cloud },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'privacy', label: 'Privacy', icon: Shield },
  { id: 'about', label: 'About', icon: Info },
  { id: 'changelog', label: 'Changelog', icon: ScrollText },
] as const;

export type SectionId = (typeof sections)[number]['id'];

/** Valid URL hashes for deep-linking a settings panel — see app/settings/client.tsx. */
export const SECTION_IDS = sections.map((s) => s.id);

/**
 * A sidebar on desktop, a horizontal strip on phones.
 *
 * Below `md` the settings grid is a single column, so a vertical list would push the panel
 * down. `md:` matches the breakpoint of the grid in app/settings/client.tsx.
 */
export function SettingsNav({
  active,
  onChange,
}: {
  active: SectionId;
  onChange: (id: SectionId) => void;
}) {
  const strip = useRef<HTMLElement>(null);

  // Keep the active tab visible in the horizontal strip: deep links (#about) and
  // settings-search can change sections without a tap on the tab.
  useEffect(() => {
    const element = strip.current;
    // Only when the strip scrolls sideways; on desktop it is a column, and scrollIntoView
    // would needlessly scroll the page.
    if (!element || element.scrollWidth <= element.clientWidth) return;
    element.querySelector('[aria-current="page"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
    });
  }, [active]);

  return (
    <nav
      ref={strip}
      aria-label="Settings sections"
      className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0"
    >
      {sections.map((s) => {
        const Icon = s.icon;
        const isActive = active === s.id;
        return (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            // aria-current so the active tab is not conveyed by tint alone.
            aria-current={isActive ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition md:w-full md:shrink md:gap-3 ${
              isActive
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" /> {s.label}
          </button>
        );
      })}
    </nav>
  );
}
