'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Library, Compass, Clock3, UserCog } from 'lucide-react';
import { authorLine } from '@/lib/manga-data';
import { useMangaLibrary } from '@/lib/library-store';
import { NavButton, type NavItem } from '@/components/nav/nav-button';
import { NavSearch, type SearchScope } from '@/components/nav/nav-search';
import { NavNotifications } from '@/components/nav/nav-notifications';
import { NavDownloads } from '@/components/nav/nav-downloads';

const leftItems: NavItem[] = [
  { label: 'Library', to: '/', icon: Library },
  { label: 'Discover', to: '/discover', icon: Compass },
  { label: 'Recents', to: '/recents', icon: Clock3 },
];

// Bookmarks isn't here: the Library page's "N bookmarked" count already links to it, and
// `g b` still jumps there — see the shortcut map in app-shell.
const rightItems: NavItem[] = [{ label: 'Settings', to: '/settings', icon: UserCog }];

type Panel = 'search' | 'bell' | null;

export function FloatingNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<SearchScope>(
    pathname.startsWith('/settings')
      ? 'settings'
      : pathname.startsWith('/discover')
        ? 'sources'
        : 'library',
  );
  const [shortcutLabel, setShortcutLabel] = useState('Ctrl+K');
  // Only one dropdown can be open at a time — opening one closes whichever else was open.
  const [activePanel, setActivePanel] = useState<Panel>(null);
  const panel = (name: Exclude<Panel, null>) => ({
    open: activePanel === name,
    onOpenChange: (v: boolean) => setActivePanel((p) => (v ? name : p === name ? null : p)),
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const isActive = (url: string) => (url === '/' ? pathname === '/' : pathname.startsWith(url));
  const { manga: mangaLibrary } = useMangaLibrary();

  // Source search is rendered by Discover (grouped per extension), while library search
  // shows local matches in the dropdown. The visible scope control can override the
  // route's default without changing how either search fetches.

  useEffect(() => {
    setScope(
      pathname.startsWith('/settings')
        ? 'settings'
        : pathname.startsWith('/discover')
          ? 'sources'
          : 'library',
    );
    setSearch('');
    setActivePanel(null);
  }, [pathname]);

  useEffect(() => {
    // A touch-only device has no keyboard shortcut to advertise.
    if (window.matchMedia?.('(hover: none) and (pointer: coarse)').matches) {
      setShortcutLabel('');
    } else if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
      setShortcutLabel('⌘K');
    }
  }, []);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || scope !== 'library') return [];
    return mangaLibrary
      .filter((m) => `${m.title} ${authorLine(m)} ${m.tags.join(' ')}`.toLowerCase().includes(q))
      .slice(0, 6);
  }, [search, mangaLibrary, scope]);

  /** Discover owns its results, so the query travels there in the URL. */
  const submitSourceSearch = (value: string) => {
    const q = value.trim();
    setActivePanel(null);
    router.push(q ? `/discover?q=${encodeURIComponent(q)}` : '/discover');
  };

  // Cmd/Ctrl+K focuses search, Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setActivePanel('search');
      }
      if (e.key === 'Escape') {
        setActivePanel(null);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (id: string) => {
    setActivePanel(null);
    setSearch('');
    router.push(`/manga/${id}`);
  };

  return (
    <nav className="pointer-events-none fixed left-1/2 top-3 z-50 w-full max-w-4xl -translate-x-1/2 px-3 sm:px-4">
      <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-1 rounded-2xl border border-border/70 bg-popover/85 p-1.5 shadow-lg shadow-black/40 backdrop-blur-xl sm:h-14 sm:flex-nowrap sm:justify-normal sm:rounded-full">
        {leftItems.map((item) => (
          <NavButton key={item.to} item={item} active={isActive(item.to)} />
        ))}

        <div className="order-last w-full sm:order-none sm:min-w-0 sm:flex-1">
          <NavSearch
            inputRef={inputRef}
            search={search}
            onSearchChange={setSearch}
            scope={scope}
            onScopeChange={(next) => {
              setScope(next);
              setSearch('');
              setActivePanel(null);
            }}
            shortcutLabel={shortcutLabel}
            {...panel('search')}
            results={results}
            onSelect={go}
            onSubmitSourceSearch={submitSourceSearch}
            onSelectSetting={(section, label) => {
              setSearch('');
              setActivePanel(null);
              window.dispatchEvent(
                new CustomEvent('projekt-manga:setting', { detail: { section, label } }),
              );
            }}
          />
        </div>

        <NavNotifications {...panel('bell')} />
        <NavDownloads />

        {rightItems.map((item) => (
          <NavButton key={item.to} item={item} active={isActive(item.to)} />
        ))}
      </div>

      {activePanel && (activePanel !== 'search' || search.trim()) ? (
        <div
          className="pointer-events-auto fixed inset-0 -z-10"
          onClick={() => setActivePanel(null)}
        />
      ) : null}
    </nav>
  );
}
