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
