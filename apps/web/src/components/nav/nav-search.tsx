import type { RefObject } from 'react';
import { Search, X } from 'lucide-react';
import type { Manga } from '@/lib/manga-data';
import { authorLine } from '@/lib/manga-data';
import { Cover } from '@/components/cover';
import { SettingsSearch } from '@/components/settings/settings-search';
import type { SectionId } from '@/components/settings/settings-nav';

export type SearchScope = 'library' | 'sources' | 'settings';

export function NavSearch({
  inputRef,
  search,
  onSearchChange,
  open,
  onOpenChange,
  results,
  onSelect,
  scope,
  onScopeChange,
  shortcutLabel,
  onSubmitSourceSearch,
  onSelectSetting,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  search: string;
  onSearchChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  results: Manga[];
  onSelect: (id: string) => void;
  scope: SearchScope;
  onScopeChange: (scope: SearchScope) => void;
  shortcutLabel: string;
  onSubmitSourceSearch?: (value: string) => void;
  onSelectSetting?: (section: SectionId, label: string) => void;
}) {
  return (
    <div className="group relative mx-1 flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-border/60 bg-secondary/70 px-3 focus-within:border-primary/60 focus-within:bg-secondary">
      <Search size={16} className="text-muted-foreground group-focus-within:text-primary" />
      {scope === 'settings' ? (
        <span className="shrink-0 text-[11px] font-medium text-primary">Settings</span>
      ) : (
        <button
          type="button"
          onClick={() => onScopeChange(scope === 'library' ? 'sources' : 'library')}
          aria-label={`Search scope: ${scope}. Switch to ${scope === 'library' ? 'sources' : 'library'}`}
          className="shrink-0 rounded-md px-1 text-[11px] font-medium text-primary pointer-coarse:min-h-8 pointer-coarse:px-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
        >
          {scope === 'library' ? 'Library' : 'Sources'}
        </button>
      )}
      <input
        ref={inputRef}
        type="text"
        aria-label={
          scope === 'settings'
            ? 'Search settings'
            : scope === 'sources'
              ? 'Search installed sources'
              : 'Search your library'
        }
        placeholder={
          scope === 'settings'
            ? `Search settings…  ${shortcutLabel}`
            : scope === 'sources'
              ? `Search installed sources…  ${shortcutLabel}`
              : `Search your library…  ${shortcutLabel}`
        }
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/80 outline-none"
        value={search}
        onFocus={() => onOpenChange(scope !== 'sources')}
        onChange={(e) => {
          onSearchChange(e.target.value);
          // Source search is a deliberate submit — scraping every extension on each
          // keystroke would be far too costly.
          onOpenChange(scope !== 'sources');
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          if (scope === 'settings') {
            e.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>('[data-setting-result]:not(:disabled)')
              ?.click();
            return;
          }
          if (scope === 'sources') {
            onSubmitSourceSearch?.(search);
            return;
          }
          if (results[0]) onSelect(results[0].id);
        }}
      />
      {search && (
        <button
          onClick={() => onSearchChange('')}
          aria-label="Clear search"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={14} />
        </button>
      )}

      {open && scope === 'library' && search.trim() && (
        <div className="absolute left-0 right-0 top-[52px] overflow-hidden rounded-2xl border border-border/70 bg-popover/95 shadow-lg shadow-black/40 backdrop-blur-xl">
          {results.length === 0 ? (
            <div className="px-4 py-5 text-center text-xs text-muted-foreground">
              No titles match “{search}”.
            </div>
          ) : (
            <ul className="max-h-80 overflow-auto py-1.5">
              {results.map((m) => (
                <li key={m.id}>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onSelect(m.id)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-accent"
                  >
                    <Cover
                      sourceId={m.source}
                      src={m.thumbnailUrl}
                      alt=""
                      className="h-10 w-7 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{m.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {authorLine(m)} · {m.latestChapter}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {open && scope === 'settings' && search.trim() && onSelectSetting && (
        <div className="absolute left-0 right-0 top-[52px] overflow-hidden rounded-2xl border border-border/70 bg-popover shadow-lg">
          <SettingsSearch query={search} onSelect={onSelectSetting} />
        </div>
      )}
    </div>
  );
}
