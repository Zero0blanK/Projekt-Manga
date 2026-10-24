import {
  buildApiUrl,
  buildImageProxyUrl,
  type MangaListItem,
  type MangaWithDetails,
  type SourceSummary,
} from '@projekt-manga/api-client';
import type { MangaDetails as SourceMangaDetails } from '@projekt-manga/types';
import { repairSourceName } from './source-language';

/** A source annotated with a cosmetic accent color, for the discover UI. */
export type DisplaySource = SourceSummary & { accent: string };

export function toDisplaySource(source: SourceSummary): DisplaySource {
  return {
    ...source,
    name: repairSourceName(source.name),
    accent: coverGradient(source.id).accent,
  };
}

export type Manga = {
  id: string;
  slug: string;
  title: string;
  authors: string[] | null;
  artists: string[] | null;
  /** Manga-level scanlation groups aren't stored by the backend (only a per-chapter
   * `scanlator`), so library rows are always null; only live source details
   * (`fromSourceDetails`) can populate it. Components that render it (`groupLine`)
   * degrade gracefully without a special case. */
  groups: string[] | null;
  source: string;
  chapters: number;
  latestChapter: string;
  latestChapterNum: number;
  updatedAt: string;
  status: 'Ongoing' | 'Completed' | 'Hiatus' | 'Cancelled' | 'Unknown';
  progress?: number; // 0..1
  currentChapter?: number;
  currentChapterTitle?: string;
  /** Page to resume `currentChapter` at — the reader should jump straight there instead
   * of restarting from page 1. Undefined when there's nothing to resume mid-chapter. */
  currentPage?: number;
  tags: string[];
  color: string; // gradient stops, derived deterministically from id
  accent: string;
  synopsis: string;
  rating: number | null;
  /** API-served cover image URL, or null when the source didn't provide one. */
  thumbnailUrl: string | null;
  /** In the user's library. False for source-backed rows that exist only so a preview,
   * download or read has something to attach to. */
  inLibrary: boolean;
};

/** Library covers use the server cache with a guarded source fallback. Live source
 * results, which have no library row, use the image proxy directly. */
/** The proxy only fetches absolute http(s) URLs — its SSRF guard rejects anything else.
 * A stored value that isn't one (a site-relative cache path, a placeholder) is treated as
 * "no cover" so the placeholder renders immediately, instead of firing a request that is
 * guaranteed to fail and leaving a broken image behind. */
function proxiedThumbnail(
  url: string | undefined | null,
  source: string,
  mangaId?: string,
  cacheHash?: string | null,
): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (mangaId)
    return buildApiUrl(
      `/cache/thumbnail/${encodeURIComponent(mangaId)}`,
      cacheHash ? { v: cacheHash } : undefined,
    );
  return buildImageProxyUrl(url, source);
}

/** Deterministic cosmetic gradient — purely decorative, not backend data. */
const COVER_STOPS: Array<[string, string]> = [
  ['oklch(0.55 0.18 25)', 'oklch(0.25 0.10 15)'],
  ['oklch(0.65 0.16 260)', 'oklch(0.20 0.10 280)'],
  ['oklch(0.60 0.15 150)', 'oklch(0.22 0.09 170)'],
  ['oklch(0.68 0.14 55)', 'oklch(0.24 0.10 30)'],
  ['oklch(0.55 0.18 320)', 'oklch(0.22 0.12 300)'],
  ['oklch(0.62 0.16 200)', 'oklch(0.20 0.10 220)'],
  ['oklch(0.60 0.17 15)', 'oklch(0.22 0.12 350)'],
  ['oklch(0.65 0.14 100)', 'oklch(0.24 0.09 120)'],
  ['oklch(0.58 0.16 240)', 'oklch(0.20 0.10 260)'],
  ['oklch(0.66 0.14 80)', 'oklch(0.24 0.10 60)'],
  ['oklch(0.55 0.19 340)', 'oklch(0.22 0.13 320)'],
  ['oklch(0.62 0.15 180)', 'oklch(0.22 0.10 200)'],
];

function hashString(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash;
}

export function coverGradient(id: string): { color: string; accent: string } {
  const [from, to] = COVER_STOPS[hashString(id) % COVER_STOPS.length];
  return { color: `linear-gradient(160deg, ${from}, ${to})`, accent: from };
}

const STATUS_MAP: Record<string, Manga['status']> = {
  ONGOING: 'Ongoing',
  COMPLETED: 'Completed',
  HIATUS: 'Hiatus',
  CANCELLED: 'Cancelled',
  UNKNOWN: 'Unknown',
};

/** `manga_detail.artist` is non-null and defaults to the literal "Unknown", so an absent
 * credit arrives as that string rather than null. Normalise it back to "no artist" so the
 * UI's own fallback wording is used instead of rendering "Unknown" as a person's name. */
function credit(value: string | null | undefined): string[] | null {
  const trimmed = (value ?? '').trim();
  return trimmed && trimmed.toLowerCase() !== 'unknown' ? [trimmed] : null;
}

function splitGenres(genres: string | undefined | null): string[] {
  return (genres ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

/** A new array sorted by chapter_number — descending (newest first) by default, since
 * that's what every caller here wants except the one "find the next chapter" lookup that
 * needs ascending order. Never mutates the input. */
export function sortByChapterNumber<T extends { chapter_number: number }>(
  items: T[],
  direction: 'asc' | 'desc' = 'desc',
): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => sign * (a.chapter_number - b.chapter_number));
}

export type ChapterStatusFilter = 'All' | 'Unread' | 'Read';

/** Shared by ChapterList and SourceChapterList's chapter filtering — the two components
 * otherwise have genuinely different row shapes (a derived ChapterRow vs. raw Chapters)
 * and different feature scope (groups/multi-mode sort only exist in ChapterList), so this
 * is the one piece of filtering logic that's actually identical between them. */
export function passesChapterStatusFilter(isRead: boolean, status: ChapterStatusFilter): boolean {
  if (status === 'Unread' && isRead) return false;
  if (status === 'Read' && !isRead) return false;
  return true;
}

/** Maps a library listing row (GET /manga, GET /manga/category/:id) onto the UI's Manga
 * shape. Listing rows don't carry rating/artist (only the detail endpoint does), and
 * carry a chapter *count*, not the latest chapter number, so both are approximated. */
export function fromMangaListItem(item: MangaListItem): Manga {
  const { color, accent } = coverGradient(item.id);
  const readCount = Math.max(0, item.chapter_count - item.unread_count);
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    authors: credit(item.author),
    artists: credit(item.manga_detail?.artist),
    groups: null,
    source: item.source,
    chapters: item.chapter_count,
    latestChapter: item.chapter_count > 0 ? `Chapter ${item.chapter_count}` : 'No chapters yet',
    latestChapterNum: item.chapter_count,
    updatedAt: item.latest_chapter_date ?? item.updated_at,
    status: STATUS_MAP[item.manga_detail?.status ?? 'UNKNOWN'] ?? 'Unknown',
    progress: readCount > 0 && item.chapter_count > 0 ? readCount / item.chapter_count : undefined,
    tags: splitGenres(item.manga_detail?.genres),
    color,
    accent,
    synopsis: item.manga_detail?.description ?? '',
    rating: item.manga_detail?.rating ?? null,
    thumbnailUrl: proxiedThumbnail(
      item.thumbnail_url,
      item.source,
      item.id,
      item.cache?.sha256_url,
    ),
    inLibrary: true,
  };
}

/** Maps the full detail response (GET /manga/details/:id) — includes rating, artist, and
 * the complete chapter list, so progress/currentChapter can be computed precisely. */
export function fromMangaDetails(item: MangaWithDetails): Manga {
  const { color, accent } = coverGradient(item.id);
  const chapters = item.chapters ?? [];
  const chapterCount = chapters.length;
  const sorted = sortByChapterNumber(chapters);
  const latest = sorted[0];
  const readChapters = chapters.filter((c) => c.is_read);
  const lastRead = sortByChapterNumber(readChapters)[0];

  // Where to resume. "Last touched" deliberately includes chapters that are only part-way
  // through (last_page_read > 0 but not yet marked read), so stopping
  // mid-chapter still leaves something to continue from.
  const touched = chapters.filter((c) => c.is_read || c.last_page_read > 0);
  const lastTouched = sortByChapterNumber(touched)[0];
  const finished = lastTouched
    ? lastTouched.is_read ||
      (lastTouched.page_count ? lastTouched.last_page_read >= lastTouched.page_count : false)
    : false;
  // `sorted` is newest-first, so finding the *next* chapter needs ascending order —
  // searching the descending list returns the last chapter of the series instead.
  const ascending = sortByChapterNumber(chapters, 'asc');
  const nextAfterTouched = lastTouched
    ? ascending.find((c) => c.chapter_number > lastTouched.chapter_number)
    : undefined;
  const continueChapter = lastTouched
    ? finished
      ? (nextAfterTouched?.chapter_number ?? lastTouched.chapter_number)
      : lastTouched.chapter_number
    : undefined;
  // Only resume mid-chapter; a finished one starts its successor from the top.
  const continuePage =
    lastTouched && !finished ? Math.max(1, lastTouched.last_page_read) : undefined;
  const continueTitle = finished ? nextAfterTouched?.name : lastTouched?.name;

  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    authors: credit(item.author),
    artists: credit(item.artist),
    groups: null,
    source: item.source,
    chapters: chapterCount,
    latestChapter: latest ? `Chapter ${latest.chapter_number}` : 'No chapters yet',
    latestChapterNum: latest?.chapter_number ?? 0,
    updatedAt: latest?.release_date ?? item.updated_at,
    status: STATUS_MAP[item.status] ?? 'Unknown',
    progress: lastRead && chapterCount > 0 ? readChapters.length / chapterCount : undefined,
    currentChapter: continueChapter,
    currentChapterTitle: continueTitle ?? undefined,
    currentPage: continuePage,
    tags: splitGenres(item.genres),
    color,
    accent,
    synopsis: item.description,
    rating: item.rating,
    thumbnailUrl: proxiedThumbnail(
      item.thumbnail_url,
      item.source,
      item.id,
      item.cache?.sha256_url,
    ),
    inLibrary: item.in_library ?? true,
  };
}

/** Maps a source's live detail payload onto the UI's Manga shape, for reading a title
 * straight from the extension without it existing in the database. Progress fields stay
 * undefined — there's no library row to track against. */
export function fromSourceDetails(item: SourceMangaDetails, sourceId: string): Manga {
  const { color, accent } = coverGradient(item.id);
  const chapters = item.chapters ?? [];
  const latest = sortByChapterNumber(chapters)[0];

  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    authors: item.author?.length ? item.author : null,
    artists: item.artist?.length ? item.artist : null,
    groups: item.groups?.length ? item.groups : null,
    source: sourceId,
    chapters: chapters.length,
    latestChapter: latest ? `Chapter ${latest.chapter_number}` : 'No chapters yet',
    latestChapterNum: latest?.chapter_number ?? 0,
    updatedAt: latest?.release_date || new Date().toISOString(),
    status: STATUS_MAP[(item.status ?? '').toUpperCase()] ?? 'Unknown',
    tags: item.genres ?? [],
    color,
    accent,
    synopsis: item.description ?? '',
    rating: null,
    thumbnailUrl: proxiedThumbnail(item.thumbnail_url, sourceId),
    inLibrary: false,
  };
}

/** A scanlation group worth showing: sources that don't know the group send "Unknown". */
export function knownGroup(scanlator: string | null | undefined): string {
  const name = scanlator?.trim() ?? '';
  return name.toLowerCase() === 'unknown' ? '' : name;
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - +new Date(iso);
  const h = diff / 3600_000;
  if (h < 1) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

/** A duration in milliseconds as a compact "3h 20m" / "45m" / "12s". Zero reads as a
 * dash rather than "0m", so an untracked total doesn't look like a measured one. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  const days = Math.floor(hours / 24);
  if (days === 0) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

/** Joins a possibly-null/empty credit list, dropping blank entries and falling back gracefully. */
function creditLine(list: string[] | null | undefined, fallback: string): string {
  const names = (list ?? []).filter((n) => n.trim().length > 0);
  return names.length > 0 ? names.join(', ') : fallback;
}

export function authorLine(manga: Manga): string {
  return creditLine(manga.authors, 'Unknown author');
}

export function artistLine(manga: Manga): string {
  return creditLine(manga.artists, 'Unknown artist');
}

export function groupLine(manga: Manga): string {
  return creditLine(manga.groups, '');
}
