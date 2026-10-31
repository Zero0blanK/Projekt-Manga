import type { HistoryEntry } from '@projekt-manga/api-client';
import type { Manga } from './manga-data';

export function recentLibraryReading(history: HistoryEntry[], library: Manga[]) {
  const byId = new Map(library.map((manga) => [manga.id, manga]));
  const bySourceSlug = new Map(library.map((manga) => [`${manga.source}\0${manga.slug}`, manga]));
  const latest = new Map<string, { manga: Manga; entry: HistoryEntry; timestamp: number }>();
  for (const entry of history) {
    const manga =
      (entry.manga_id && byId.get(entry.manga_id)) ??
      bySourceSlug.get(`${entry.source}\0${entry.manga_slug}`);
    if (!manga) continue;
    const lastRead = Date.parse(entry.last_read);
    const timestamp = Number.isFinite(lastRead) ? lastRead : Date.parse(entry.read_at);
    if (!Number.isFinite(timestamp) || timestamp <= (latest.get(manga.id)?.timestamp ?? -Infinity))
      continue;
    latest.set(manga.id, { manga, entry, timestamp });
  }
  return [...latest.values()].sort((a, b) => b.timestamp - a.timestamp);
}

/** Pick the library title actually read most recently, not the first row on a shelf. */
export function mostRecentlyReadLibraryManga(
  history: HistoryEntry[],
  library: Manga[],
): Manga | null {
  const byId = new Map(library.map((manga) => [manga.id, manga]));
  const bySourceSlug = new Map(library.map((manga) => [`${manga.source}\0${manga.slug}`, manga]));
  let mostRecent: Manga | null = null;
  let latestRead = -Infinity;

  for (const entry of history) {
    const manga =
      (entry.manga_id && byId.get(entry.manga_id)) ??
      bySourceSlug.get(`${entry.source}\0${entry.manga_slug}`);
    if (!manga) continue;
    const lastRead = Date.parse(entry.last_read);
    const timestamp = Number.isFinite(lastRead) ? lastRead : Date.parse(entry.read_at);
    if (!Number.isFinite(timestamp) || timestamp <= latestRead) continue;
    mostRecent = manga;
    latestRead = timestamp;
  }

  return mostRecent;
}

/**
 * Reading on a linked source (Linked sources) counted as reading the main title: each
 * history entry of a linked title is credited to its group's primary, so Continue reading
 * and the latest chapter follow the library entry rather than a title outside it.
 */
export function creditLinkedReading<T extends Pick<HistoryEntry, 'manga_id'>>(
  history: readonly T[],
  groups: ReadonlyArray<{ primary_id: string; linked: ReadonlyArray<{ id: string }> }>,
): T[] {
  const primaryOf = new Map<string, string>();
  for (const group of groups)
    for (const linked of group.linked) primaryOf.set(linked.id, group.primary_id);
  if (primaryOf.size === 0) return [...history];
  return history.map((entry) => {
    const primary = entry.manga_id ? primaryOf.get(entry.manga_id) : undefined;
    return primary ? { ...entry, manga_id: primary } : entry;
  });
}
