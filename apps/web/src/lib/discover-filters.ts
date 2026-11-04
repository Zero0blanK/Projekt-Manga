import { sourceLanguageName } from './source-language';

/** The Discover filter bar's choices, shared by Installed sources and Extensions. */
export type DiscoverFilters = {
  /** A language group (`en`, `multi`…), or '' for every language. */
  language: string;
  /** Where sources come from: `repo:<repository id>`, `suwayomi`, or '' for everywhere. */
  origin: string;
  rating: '' | 'safe' | 'mixed' | 'nsfw';
  /** Only sources whose last request failed (Installed sources). */
  health: '' | 'failing';
};

export const EMPTY_DISCOVER_FILTERS: DiscoverFilters = {
  language: '',
  origin: '',
  rating: '',
  health: '',
};

const RATINGS = new Set(['safe', 'mixed', 'nsfw']);

/** The filters kept in the page's URL, so Back from a source returns to them. `prefix`
 * keeps the two tabs' filters apart. */
export function readDiscoverFilters(params: URLSearchParams, prefix = ''): DiscoverFilters {
  const rating = params.get(`${prefix}rating`) ?? '';
  return {
    language: params.get(`${prefix}lang`) ?? '',
    origin: params.get(`${prefix}from`) ?? '',
    rating: RATINGS.has(rating) ? (rating as DiscoverFilters['rating']) : '',
    health: params.get(`${prefix}health`) === 'failing' ? 'failing' : '',
  };
}

export function writeDiscoverFilters(
  params: URLSearchParams,
  filters: DiscoverFilters,
  prefix = '',
): void {
  const values = {
    lang: filters.language,
    from: filters.origin,
    rating: filters.rating,
    health: filters.health,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value) params.set(`${prefix}${name}`, value);
    else params.delete(`${prefix}${name}`);
  }
}

export const SUWAYOMI_ORIGIN = 'suwayomi';
export const repositoryOrigin = (repositoryId: string) => `repo:${repositoryId}`;
/** The repository an origin names, or null for Suwayomi or everywhere. */
export const originRepositoryId = (origin: string) =>
  origin.startsWith('repo:') ? origin.slice('repo:'.length) : null;

/** Multilingual first, then English, then every other language by name. */
export function compareLanguageGroups(a: string, b: string): number {
  // `sourceLanguageGroup` names the multilingual group `multi`.
  const rank = (group: string) =>
    group === 'multi' || group === 'all' ? 0 : group === 'en' ? 1 : 2;
  return rank(a) - rank(b) || sourceLanguageName(a).localeCompare(sourceLanguageName(b));
}
