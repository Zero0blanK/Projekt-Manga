import { sourceLanguageName } from './source-language';

/** The Discover filter bar's choices, shared by Installed sources and Extensions. */
export type DiscoverFilters = {
  /** A language group (`en`, `multi`…), or '' for every language. */
  language: string;
  /** Where sources come from: `repo:<repository id>`, `suwayomi`, or '' for everywhere. */
  origin: string;
  rating: '' | 'safe' | 'mixed' | 'nsfw';
};

export const EMPTY_DISCOVER_FILTERS: DiscoverFilters = { language: '', origin: '', rating: '' };

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
