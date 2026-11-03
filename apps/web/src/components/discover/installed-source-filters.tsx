'use client';

import { EMPTY_DISCOVER_FILTERS, type DiscoverFilters } from '@/lib/discover-filters';
import { sourceLanguageName } from '@/lib/source-language';

const SELECT =
  'h-8 rounded-lg border border-border/60 bg-background px-2 text-xs text-foreground outline-none focus:border-primary/60';

/**
 * Discover's filter bar, beside the name search: where sources come from (each extension
 * repository by its author, or the Suwayomi server), language and content rating. Used
 * by both Installed sources and Extensions.
 */
export function DiscoverFilterBar({
  label,
  value,
  onChange,
  languages,
  origins,
  count,
  filtered,
}: {
  label: string;
  value: DiscoverFilters;
  onChange: (value: DiscoverFilters) => void;
  languages: string[];
  /** Offered only when there is more than one place sources come from. */
  origins: Array<{ value: string; label: string }>;
  /** Shown while something narrows the list; omit where the list counts itself. */
  count?: number;
  filtered: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="mb-6 flex flex-wrap items-center gap-2">
      {origins.length > 1 && (
        <select
          aria-label="Source repository"
          className={SELECT}
          value={value.origin}
          onChange={(event) => onChange({ ...value, origin: event.target.value })}
        >
          <option value="">All</option>
          {origins.map((origin) => (
            <option key={origin.value} value={origin.value}>
              {origin.label}
            </option>
          ))}
        </select>
      )}
      <select
        aria-label="Language"
        className={SELECT}
        value={value.language}
        onChange={(event) => onChange({ ...value, language: event.target.value })}
      >
        <option value="">All languages</option>
        {languages.map((language) => (
          <option key={language} value={language}>
            {sourceLanguageName(language)}
          </option>
        ))}
      </select>
      <select
        aria-label="Content rating"
        className={SELECT}
        value={value.rating}
        onChange={(event) =>
          onChange({ ...value, rating: event.target.value as DiscoverFilters['rating'] })
        }
      >
        <option value="">All ratings</option>
        <option value="safe">Safe</option>
        <option value="mixed">Mixed</option>
        <option value="nsfw">Adult</option>
      </select>
      {filtered && count !== undefined && (
        <span role="status" className="text-xs text-muted-foreground">
          {count} {count === 1 ? 'source' : 'sources'}
        </span>
      )}
      {(value.language || value.origin || value.rating) && (
        <button
          type="button"
          className="text-xs text-primary"
          onClick={() => onChange(EMPTY_DISCOVER_FILTERS)}
        >
          Reset filters
        </button>
      )}
    </div>
  );
}
