import type { Source } from '@projekt-manga/types';
import { absoluteSuwayomiUrl, suwayomiGraphql } from './client.js';
import { onSuwayomiSettingsChange, readSuwayomiConnection } from './settings.js';
import { createSuwayomiSource, SUWAYOMI_PREFIX, type SuwayomiSourceInfo } from './source.js';

/**
 * The sources the host's Suwayomi server offers, listed beside the installed extensions.
 *
 * The list is cached briefly: Discover asks for it on every visit and Suwayomi only
 * changes it when an extension is installed there. When the server is off, its sources
 * drop out of the list, but a title already in the library still resolves to its source,
 * which then reports that Suwayomi is unreachable instead of "source not found".
 */

const LIST_TTL_MS = 60_000;
const FAILED_LIST_TTL_MS = 15_000;

const SOURCES_QUERY = `query {
  sources { nodes { id name lang iconUrl isNsfw supportsLatest baseUrl } }
}`;

export interface SuwayomiSourceSummary {
  id: string;
  name: string;
  lang: string;
  base_url: string;
  isNSFW: boolean;
  provider: 'suwayomi';
  icon_url: string | null;
}

interface Listing {
  at: number;
  ttl: number;
  infos: SuwayomiSourceInfo[];
}

let listing: Listing | null = null;
let pending: Promise<SuwayomiSourceInfo[]> | null = null;
const sources = new Map<string, { info: SuwayomiSourceInfo; source: Source }>();

onSuwayomiSettingsChange(() => {
  listing = null;
  pending = null;
  sources.clear();
});

export const isSuwayomiSourceId = (id: string) => id.startsWith(SUWAYOMI_PREFIX);

function isInfo(value: unknown): value is SuwayomiSourceInfo {
  const node = value as Partial<SuwayomiSourceInfo> | null;
  return (
    !!node &&
    typeof node.id === 'string' &&
    /^-?\d{1,20}$/.test(node.id) &&
    typeof node.name === 'string' &&
    typeof node.lang === 'string'
  );
}

/** Fetches Suwayomi's source list. Throws when the server can't be reached. */
export async function fetchSuwayomiSourceInfos(): Promise<SuwayomiSourceInfo[]> {
  const data = await suwayomiGraphql<{ sources: { nodes: unknown[] } }>(SOURCES_QUERY);
  return (data.sources?.nodes ?? []).filter(isInfo).map((node) => ({
    id: node.id,
    name: node.name,
    // Suwayomi's own Local source (files on that server) has no real language.
    lang: node.lang === 'localsourcelang' ? 'all' : node.lang,
    iconUrl: typeof node.iconUrl === 'string' ? node.iconUrl : null,
    isNsfw: node.isNsfw === true,
    supportsLatest: node.supportsLatest === true,
    baseUrl: typeof node.baseUrl === 'string' ? node.baseUrl : null,
  }));
}

async function listInfos(): Promise<SuwayomiSourceInfo[]> {
  if (!readSuwayomiConnection()) return [];
  if (listing && Date.now() - listing.at < listing.ttl) return listing.infos;
  pending ??= fetchSuwayomiSourceInfos()
    .then((infos) => {
      listing = { at: Date.now(), ttl: LIST_TTL_MS, infos };
      return infos;
    })
    .catch((error: unknown) => {
      console.warn(
        `[Suwayomi] Could not list sources: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      listing = { at: Date.now(), ttl: FAILED_LIST_TTL_MS, infos: [] };
      return [];
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

function sourceFor(info: SuwayomiSourceInfo): Source {
  const id = `${SUWAYOMI_PREFIX}${info.id}`;
  const existing = sources.get(id);
  if (existing && JSON.stringify(existing.info) === JSON.stringify(info)) return existing.source;
  const source = createSuwayomiSource(info);
  sources.set(id, { info, source });
  return source;
}

export async function getSuwayomiSources(): Promise<Source[]> {
  return (await listInfos()).map(sourceFor);
}

export async function getSuwayomiSourceSummaries(): Promise<SuwayomiSourceSummary[]> {
  const connection = readSuwayomiConnection();
  if (!connection) return [];
  return (await listInfos()).map((info) => ({
    id: `${SUWAYOMI_PREFIX}${info.id}`,
    name: info.name,
    lang: info.lang,
    base_url: info.baseUrl ?? '',
    isNSFW: info.isNsfw,
    provider: 'suwayomi' as const,
    icon_url: absoluteSuwayomiUrl(info.iconUrl, connection) || null,
  }));
}

/** The Suwayomi source with this id, or undefined when it isn't one or Suwayomi isn't
 * connected. A source missing from a failed listing still resolves, so its calls report
 * the real reason. */
export async function getSuwayomiSource(id: string): Promise<Source | undefined> {
  if (!isSuwayomiSourceId(id) || !readSuwayomiConnection()) return undefined;
  const rawId = id.slice(SUWAYOMI_PREFIX.length);
  if (!/^-?\d{1,20}$/.test(rawId)) return undefined;
  const info = (await listInfos()).find((candidate) => candidate.id === rawId);
  if (info) return sourceFor(info);
  const known = sources.get(id);
  if (known) return known.source;
  if (listing?.ttl === LIST_TTL_MS) return undefined; // listed fine, and not there
  return sourceFor({
    id: rawId,
    name: 'Suwayomi source',
    lang: '',
    iconUrl: null,
    isNsfw: false,
    supportsLatest: false,
    baseUrl: null,
  });
}

/** Drops the cached source list, after an extension was installed or removed there. */
export function forgetSuwayomiSourceList(): void {
  listing = null;
  pending = null;
}

/** Test seam: forgets every cached list and source. */
export function resetSuwayomiRegistryForTests(): void {
  listing = null;
  pending = null;
  sources.clear();
}
