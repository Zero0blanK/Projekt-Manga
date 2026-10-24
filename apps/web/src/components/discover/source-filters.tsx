'use client';

export type SourceFiltersValue = {
  name: string;
  language: string | string[];
  rating: string;
  status: string;
};
export const emptySourceFilters: SourceFiltersValue = {
  name: '',
  language: '',
  rating: '',
  status: '',
};
export function matchesSourceFilters(
  source: { name: string; lang?: string | null; content_rating?: string | null; isNSFW: boolean },
  installed: boolean,
  filters: SourceFiltersValue,
) {
  const rating = source.content_rating ?? (source.isNSFW ? 'nsfw' : 'unknown');
  const languages = Array.isArray(filters.language)
    ? filters.language
    : filters.language
      ? [filters.language]
      : [];
  return (
    source.name.toLocaleLowerCase().includes(filters.name.trim().toLocaleLowerCase()) &&
    (languages.length === 0 ||
      source.lang === 'all' ||
      languages.includes(source.lang || 'unknown')) &&
    (!filters.rating || rating === filters.rating) &&
    (!filters.status || installed === (filters.status === 'installed'))
  );
}
export function SourceFilters({
  value,
  onChange,
  languages,
}: {
  value: SourceFiltersValue;
  onChange: (value: SourceFiltersValue) => void;
  languages: string[];
}) {
  const selectClass = 'rounded-lg border border-border bg-background px-3 py-2 text-sm';
  const multipleLanguages =
    Array.isArray(value.language) && value.language.length > 0 ? value.language : null;
  const languageLabel = multipleLanguages
    ? multipleLanguages.join(', ')
    : typeof value.language === 'string'
      ? value.language
      : '';
  return (
    <div className="mt-5 flex flex-wrap gap-3" role="group" aria-label="Source catalogue filters">
      <label className="text-xs">
        Name
        <input
          aria-label="Source name"
          className={`ml-2 ${selectClass}`}
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </label>
      <label className="text-xs">
        Language
        <select
          className={`ml-2 ${selectClass}`}
          value={multipleLanguages ? '__setup_languages__' : languageLabel}
          onChange={(event) => onChange({ ...value, language: event.target.value })}
        >
          <option value="">All languages</option>
          {multipleLanguages && (
            <option value="__setup_languages__">Setup languages: {languageLabel}</option>
          )}
          {languages.map((lang) => (
            <option key={lang} value={lang}>
              {lang === 'unknown' ? 'Unknown language' : lang}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs">
        Rating
        <select
          className={`ml-2 ${selectClass}`}
          value={value.rating}
          onChange={(event) => onChange({ ...value, rating: event.target.value })}
        >
          <option value="">All ratings</option>
          <option value="safe">Safe</option>
          <option value="mixed">Mixed</option>
          <option value="nsfw">Adult</option>
          <option value="unknown">Unknown rating</option>
        </select>
      </label>
      <label className="text-xs">
        Status
        <select
          className={`ml-2 ${selectClass}`}
          value={value.status}
          onChange={(event) => onChange({ ...value, status: event.target.value })}
        >
          <option value="">All statuses</option>
          <option value="installed">Installed</option>
          <option value="available">Available</option>
        </select>
      </label>
      <button
        type="button"
        className="text-sm text-primary"
        onClick={() => onChange(emptySourceFilters)}
      >
        Reset filters
      </button>
      {(value.name || languageLabel || value.rating || value.status) && (
        <p className="w-full text-xs text-muted-foreground">
          Active filters:{' '}
          {[
            value.name && `Name: ${value.name}`,
            languageLabel && `Language: ${languageLabel}`,
            value.rating && `Rating: ${value.rating}`,
            value.status && `Status: ${value.status}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
