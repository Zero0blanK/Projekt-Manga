'use client';

import { SelectMenu, type SelectMenuOption } from '@/components/ui/select-menu';
import {
  EMPTY_DISCOVER_FILTERS,
  SUWAYOMI_ORIGIN,
  type DiscoverFilters,
} from '@/lib/discover-filters';
import { sourceLanguageName } from '@/lib/source-language';

/** A filter's dropdown, tinted while it narrows the list. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
}) {
  return (
    <SelectMenu
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      className={value ? 'border-primary/60 text-primary' : undefined}
    />
  );
}

/**
 * Discover's filter bar, beside the name search: where sources come from (each extension
 * repository by its author, or the Suwayomi server), language, content rating and, on
 * Installed sources, health. Used by both Installed sources and Extensions.
 */
export function DiscoverFilterBar({
  label,
  value,
  onChange,
  languages,
  origins,
  showHealth = false,
  count,
  filtered,
}: {
  label: string;
  value: DiscoverFilters;
  onChange: (value: DiscoverFilters) => void;
  languages: string[];
  /** Offered only when there is more than one place sources come from. */
  origins: Array<{ value: string; label: string }>;
  showHealth?: boolean;
  /** Shown while something narrows the list; omit where the list counts itself. */
  count?: number;
  filtered: boolean;
}) {
  // Suwayomi only says whether something is adult; it has no "mixed" rating.
  const suwayomi = value.origin === SUWAYOMI_ORIGIN;
  return (
    <div role="group" aria-label={label} className="mb-6 flex flex-wrap items-center gap-2">
      {origins.length > 1 && (
        <FilterSelect
          label="Source repository"
          value={value.origin}
          onChange={(origin) =>
            onChange({
              ...value,
              origin,
              rating: origin === SUWAYOMI_ORIGIN && value.rating === 'mixed' ? '' : value.rating,
            })
          }
          options={[{ value: '', label: 'All' }, ...origins]}
        />
      )}
      <FilterSelect
        label="Language"
        value={value.language}
        onChange={(language) => onChange({ ...value, language })}
        options={[
          { value: '', label: 'All languages' },
          ...languages.map((language) => ({
            value: language,
            label: sourceLanguageName(language),
          })),
        ]}
      />
      <FilterSelect
        label="Content rating"
        value={value.rating}
        onChange={(rating) => onChange({ ...value, rating: rating as DiscoverFilters['rating'] })}
        options={[
          { value: '', label: 'All ratings' },
          { value: 'safe', label: 'Safe' },
          ...(suwayomi ? [] : [{ value: 'mixed', label: 'Mixed' }]),
          { value: 'nsfw', label: 'Adult' },
        ]}
      />
      {showHealth && (
        <FilterSelect
          label="Source health"
          value={value.health}
          onChange={(health) => onChange({ ...value, health: health as DiscoverFilters['health'] })}
          options={[
            { value: '', label: 'Any health' },
            { value: 'failing', label: 'Failing' },
          ]}
        />
      )}
      {filtered && count !== undefined && (
        <span role="status" className="text-xs text-muted-foreground">
          {count} {count === 1 ? 'source' : 'sources'}
        </span>
      )}
      {(value.language || value.origin || value.rating || value.health) && (
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
