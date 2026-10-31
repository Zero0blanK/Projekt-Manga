import type { SourceUrlKeys } from '@projekt-manga/api-client';
import { SOURCE_URL_KEYS_LIMIT } from '@projekt-manga/schemas';
import type { MihonBackup } from './decode';
import type { SourceKeys } from './payload';

export type FetchSourceKeys = (
  sourceId: string,
  urls: { manga: string[]; chapters: string[] },
  signal?: AbortSignal,
) => Promise<SourceUrlKeys>;

const unsupported = (): SourceKeys => ({ supported: false, manga: new Map(), chapters: new Map() });

/**
 * Asks each matched source to turn the backup's URLs into its own slugs and chapter keys,
 * in batches the endpoint accepts. Only chapters that carry state (and history rows) are
 * converted, since nothing else is imported. A source that cannot convert them, or a
 * failed request, leaves that source on the chapter-number fallback.
 */
export async function resolveMihonKeys(
  backup: MihonBackup,
  sources: ReadonlyMap<string, string | null>,
  fetchKeys: FetchSourceKeys,
  signal?: AbortSignal,
): Promise<Map<string, SourceKeys>> {
  const wanted = new Map<string, { manga: Set<string>; chapters: Set<string> }>();
  for (const title of backup.manga) {
    if (!sources.get(title.source) || !title.url) continue;
    const urls = wanted.get(title.source) ?? { manga: new Set(), chapters: new Set() };
    urls.manga.add(title.url);
    for (const chapter of title.chapters)
      if (chapter.url && (chapter.read || chapter.bookmark || chapter.lastPageRead > 0))
        urls.chapters.add(chapter.url);
    for (const row of title.history) if (row.url) urls.chapters.add(row.url);
    wanted.set(title.source, urls);
  }

  const result = new Map<string, SourceKeys>();
  for (const [mihonId, urls] of wanted) {
    const sourceId = sources.get(mihonId)!;
    const keys: SourceKeys = { supported: true, manga: new Map(), chapters: new Map() };
    const queue = [
      ...[...urls.manga].map((url) => ['manga', url] as const),
      ...[...urls.chapters].map((url) => ['chapter', url] as const),
    ];
    try {
      for (let start = 0; start < queue.length && keys.supported; start += SOURCE_URL_KEYS_LIMIT) {
        const batch = queue.slice(start, start + SOURCE_URL_KEYS_LIMIT);
        const manga = batch.filter(([kind]) => kind === 'manga').map(([, url]) => url);
        const chapters = batch.filter(([kind]) => kind === 'chapter').map(([, url]) => url);
        const response = await fetchKeys(sourceId, { manga, chapters }, signal);
        if (!response.supported) {
          keys.supported = false;
          break;
        }
        manga.forEach((url, index) => keys.manga.set(url, response.manga[index] ?? null));
        chapters.forEach((url, index) => keys.chapters.set(url, response.chapters[index] ?? null));
      }
    } catch {
      signal?.throwIfAborted();
      // An older server has no key endpoint; fall back rather than fail the import.
      result.set(mihonId, unsupported());
      continue;
    }
    result.set(mihonId, keys.supported ? keys : unsupported());
  }
  return result;
}
