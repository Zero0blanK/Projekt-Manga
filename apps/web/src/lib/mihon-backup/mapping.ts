import type { TrackerName } from '@projekt-manga/api-client';
import type { MihonBackup, MihonTracking } from './decode';

/** An installed source, as `getSources` lists it. */
export interface InstalledSource {
  id: string;
  name: string;
  lang: string;
}

export type SourceMatch =
  | { kind: 'matched'; sourceId: string }
  /** The name fits several installed sources (one per language) and nothing says which. */
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unmatched' };

export interface MihonSourceSummary {
  /** Mihon's numeric source id, as a string. */
  id: string;
  name: string;
  titles: number;
  match: SourceMatch;
}

/** Trailing "(EN)", "(pt-BR)" and the like, which Mihon adds to some source names. */
const LANGUAGE_SUFFIX = /\s*\(([a-z]{2,3}(?:[-_][a-z0-9]{2,4})?|all|multi)\)\s*$/i;

/** Case, accents, spacing and punctuation never decide a match. */
export function normaliseSourceName(name: string): string {
  return name
    .replace(LANGUAGE_SUFFIX, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const normaliseLanguage = (lang: string) => lang.trim().toLowerCase().replace('_', '-');

/**
 * Matches one Mihon source to an installed source by normalised name. The language only
 * counts when the name repeats among installed sources: it is then read from a language
 * suffix on Mihon's name ("MangaDex (EN)"). Without one the match is ambiguous, for the
 * reader to settle.
 */
export function matchSource(name: string, installed: InstalledSource[]): SourceMatch {
  const key = normaliseSourceName(name);
  if (!key) return { kind: 'unmatched' };
  const candidates = installed.filter((source) => normaliseSourceName(source.name) === key);
  if (candidates.length === 0) return { kind: 'unmatched' };
  if (candidates.length === 1) return { kind: 'matched', sourceId: candidates[0].id };
  const hint = LANGUAGE_SUFFIX.exec(name)?.[1];
  if (hint) {
    const lang = normaliseLanguage(hint);
    const byLanguage = candidates.filter((source) => normaliseLanguage(source.lang) === lang);
    if (byLanguage.length === 1) return { kind: 'matched', sourceId: byLanguage[0].id };
  }
  return { kind: 'ambiguous', candidates: candidates.map((source) => source.id) };
}

/** Every source the backup's titles use, with its match. A title whose source has no
 * `backupSources` entry is listed under its bare id, which never matches. */
export function summariseSources(
  backup: MihonBackup,
  installed: InstalledSource[],
): MihonSourceSummary[] {
  const names = new Map(backup.sources.map((source) => [source.id, source.name]));
  const titles = new Map<string, number>();
  for (const manga of backup.manga) titles.set(manga.source, (titles.get(manga.source) ?? 0) + 1);
  return [...titles.entries()]
    .map(([id, count]) => {
      const name = names.get(id) ?? '';
      return {
        id,
        name: name || `Unknown source ${id}`,
        titles: count,
        match: name ? matchSource(name, installed) : ({ kind: 'unmatched' } as const),
      };
    })
    .sort((a, b) => b.titles - a.titles || a.name.localeCompare(b.name));
}

/** Mihon's tracker ids (`TrackerManager`) to this app's tracker names. */
export const MIHON_TRACKERS: Readonly<Record<number, TrackerName>> = {
  1: 'MYANIMELIST',
  2: 'ANILIST',
  3: 'KITSU',
  4: 'SHIKIMORI',
  5: 'BANGUMI',
  6: 'KOMGA',
  7: 'MANGAUPDATES',
  8: 'KAVITA',
};

/** The self-hosted trackers keep their series id in the tracking URL
 * (`…/api/v1/series/<id>`), not in Mihon's numeric media id. */
function seriesIdFromUrl(url: string): string | null {
  const match = /\/series\/([A-Za-z0-9_-]{1,64})\/?(?:[?#].*)?$/i.exec(url.trim());
  return match?.[1] ?? null;
}

/** A Mihon tracking row as this app's tracker link, or null when it cannot be one. */
export function mapTracking(
  tracking: MihonTracking,
): { tracker: TrackerName; tracker_media_id: string } | null {
  const tracker = MIHON_TRACKERS[tracking.syncId];
  if (!tracker) return null;
  const numeric = /^[1-9]\d{0,18}$/.test(tracking.mediaId) ? tracking.mediaId : null;
  const mediaId =
    tracker === 'KOMGA'
      ? seriesIdFromUrl(tracking.trackingUrl)
      : tracker === 'KAVITA'
        ? (seriesIdFromUrl(tracking.trackingUrl) ?? numeric)
        : numeric;
  return mediaId ? { tracker, tracker_media_id: mediaId } : null;
}

/** Mihon's SManga status codes to this app's statuses. */
export function mapStatus(status: number): string {
  switch (status) {
    case 1:
      return 'ONGOING';
    case 2:
    case 4: // publishing finished
      return 'COMPLETED';
    case 5:
      return 'CANCELLED';
    case 6:
      return 'HIATUS';
    default:
      return 'UNKNOWN';
  }
}
