import type { GetMangaOptions, AddMangaPayload } from '@projekt-manga/types';
import { SESSION_COOKIE_NAME } from '@projekt-manga/types';
import { ApiError, request } from './client.js';
import { hasLocalDataBridge, localInvoke } from './runtime.js';

export interface Manga {
  id: string;
  /** False for rows that exist only to back a source preview/download. */
  in_library: boolean;
  slug: string;
  title: string;
  author: string;
  source: string;
  thumbnail_url: string;
  /** Present on server responses when a private cover has been cached. */
  cache?: { sha256_url: string } | null;
  created_at: string;
  updated_at: string;
}

export interface MangaDetailSummary {
  status: string;
  genres: string;
  description: string;
  /** Null when the source never supplied one; the column itself is non-null and defaults
   * to "Unknown", so treat that string as "no artist" rather than a real credit. */
  artist: string | null;
  rating: number | null;
}

/** Shape returned by the library listing endpoints (GET /manga, GET /manga/category/:id). */
export interface MangaListItem extends Manga {
  chapter_count: number;
  latest_chapter_date: string | null;
  unread_count: number;
  /** Only populated by GET /manga; GET /manga/category/:id omits it. */
  manga_detail?: MangaDetailSummary | null;
}

export interface MangaChapterRecord {
  id: string;
  manga_id: string | null;
  url: string;
  name: string | null;
  scanlator: string | null;
  is_read: boolean;
  is_bookmark: boolean;
  chapter_number: number;
  last_page_read: number;
  page_count: number | null;
  fetched_at: string | null;
  release_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface MangaWithDetails extends Manga {
  status: string;
  genres: string;
  description: string;
  rating: number | null;
  artist: string | null;
  chapters: MangaChapterRecord[];
}

export interface MangaCategoryLink {
  manga_id: string;
  category_id: string;
}

// Local-first sort options are intentionally ignored below: the desktop local DB is
// small enough (one person's own library) that server-side sorting isn't worth
// replicating yet — see apps/desktop/src/main/db/local-store.ts's listLibrary(), which
// always orders by title. Revisit if that stops being true.
/** HTTP-only view of this session's server library, including on desktop. */
export const getServerManga = (options: GetMangaOptions = {}, signal?: AbortSignal) =>
  request<MangaListItem[]>('/manga', {
    query: { sortBy: options.sortBy, sortOrder: options.sortOrder },
    signal,
  });

export const getManga = (options: GetMangaOptions = {}, signal?: AbortSignal) => {
  if (hasLocalDataBridge()) {
    // localInvoke has no AbortSignal parameter — `signal` is silently dropped on this
    // branch, so cancellation is only honoured on the HTTP path below. A caller relying on
    // abort here keeps waiting on desktop.
    return localInvoke<MangaListItem[]>('manga', 'listLibrary');
  }
  return getServerManga(options, signal);
};

export const getMangaById = (mangaId: string, signal?: AbortSignal) =>
  request<Manga | null>(`/manga/${encodeURIComponent(mangaId)}`, { signal });

export const getMangaDetailsById = (
  mangaId: string,
  signal?: AbortSignal,
  sessionToken?: string,
) => {
  if (hasLocalDataBridge()) {
    return localInvoke<MangaWithDetails>('manga', 'getDetails', { mangaId });
  }
  return request<MangaWithDetails>(`/manga/details/${encodeURIComponent(mangaId)}`, {
    signal,
    headers: sessionToken
      ? { Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` }
      : undefined,
    cache: 'no-store',
  });
};

/**
 * Mirrors a library write into the desktop's local database.
 *
 * `getManga` above reads the library from the local database on desktop, but writes go
 * only to the API. Without mirroring, a title added mid-session stays invisible until the
 * next app start re-seeds, and re-adding it fails because the API already has the row.
 *
 * Deliberately best-effort: the HTTP write has already succeeded and is the source of
 * truth by the time this runs, so a failure here must not turn a successful add into a
 * reported failure. A later retry can reconcile that exact title from the server library.
 */
async function mirrorLibraryWrite(mangaId: string, inLibrary: boolean): Promise<boolean> {
  if (!hasLocalDataBridge()) return true;
  try {
    if (inLibrary) {
      return await localInvoke<boolean>('manga', 'syncOne', { mangaId });
    } else {
      await localInvoke('manga', 'setInLibrary', { mangaId, inLibrary: false });
      return true;
    }
  } catch {
    // The server write may already have succeeded; callers must not report it as failed.
    return false;
  }
}

export const addManga = async (payload: AddMangaPayload) => {
  let created: Manga;
  try {
    created = await request<Manga>('/manga/add', { method: 'POST', body: payload });
  } catch (error) {
    // An earlier desktop add may have reached the server while its local mirror was
    // unavailable. Recover only when this exact source/slug is already in this library.
    if (
      !(error instanceof ApiError) ||
      error.status !== 409 ||
      payload.in_library === false ||
      !hasLocalDataBridge()
    ) {
      throw error;
    }
    const existing = (await getServerManga()).find(
      (manga) => manga.source === payload.source && manga.slug === payload.slug,
    );
    if (!existing || !(await mirrorLibraryWrite(existing.id, true))) throw error;
    return existing;
  }
  // `in_library: false` is the shadow-row case (a preview download/read needs a manga_id
  // without the title joining the library), so it must not be mirrored as a member.
  if (payload.in_library !== false) {
    await mirrorLibraryWrite(created.id, true);
  }
  return created;
};

/** Adds or removes an existing manga row from the library. Removing keeps the row (and
 * its chapters, downloads and progress) — it just stops appearing in the library. */
export const setMangaInLibrary = async (mangaId: string, inLibrary: boolean) => {
  const updated = await request<Manga>(`/manga/${encodeURIComponent(mangaId)}/library`, {
    method: 'PATCH',
    body: { in_library: inLibrary },
  });
  await mirrorLibraryWrite(mangaId, inLibrary);
  return updated;
};

export const addMangaToCategory = (categoryId: string, mangaSlug: string) =>
  request<MangaCategoryLink>(
    `/manga/${encodeURIComponent(categoryId)}/${encodeURIComponent(mangaSlug)}/add`,
    { method: 'POST' },
  );

export interface MigrationSummary {
  /** Furthest chapter number read on the old entry; 0 if nothing was read. */
  progress: number;
  chapters_marked: number;
  categories_moved: number;
  history_moved: number;
  state_copied: boolean;
  old_entry_removed: boolean;
}

export interface MigrateMangaOptions {
  /** Take the old entry out of the library once everything has moved. Defaults to true
   * server-side. */
  remove_old?: boolean;
  /** Re-point the title's history rows at the new entry. Defaults to true server-side —
   * history keeps its own source/slug, so this preserves where each chapter was read. */
  move_history?: boolean;
}

/**
 * Moves a library entry's reading progress, shelf, rating and categories onto another
 * entry — the "switch this series to a different source" flow.
 *
 * One request, one transaction: it either lands completely or not at all. Both manga
 * rows must already exist; migration never creates either.
 */
export const migrateManga = (
  fromMangaId: string,
  toMangaId: string,
  options: MigrateMangaOptions = {},
) =>
  request<MigrationSummary>(`/manga/${encodeURIComponent(fromMangaId)}/migrate`, {
    method: 'POST',
    body: { to_manga_id: toMangaId, ...options },
  });

export const deleteManga = (mangaId: string) =>
  request<boolean>(`/manga/${encodeURIComponent(mangaId)}/delete`, { method: 'DELETE' });

export const getMangaByCategoryId = (
  categoryId: string,
  options: GetMangaOptions = {},
  signal?: AbortSignal,
) =>
  request<MangaListItem[]>(`/manga/category/${encodeURIComponent(categoryId)}`, {
    query: { sortBy: options.sortBy, sortOrder: options.sortOrder },
    signal,
  });
