import type { GetMangaOptions, AddMangaPayload } from '@projekt-manga/types';
import { SESSION_COOKIE_NAME } from '@projekt-manga/types';
import { ApiError, fetchAllPages, request } from './client.js';
import { localInvoke, usesLocalFirstData } from './runtime.js';
import type {
  Manga,
  MangaOverride,
  MangaOverrideRecord,
  UpdateMangaOverridePayload,
  MangaDetailSummary,
  MangaListItem,
  MangaChapterRecord,
  MangaWithDetails,
  MangaCategoryLink,
  MigrationSummary,
  MigrateMangaOptions,
  LinkedTitle,
  MangaLinkGroup,
} from '@projekt-manga/types';
export type {
  Manga,
  MangaOverride,
  MangaOverrideRecord,
  UpdateMangaOverridePayload,
  MangaDetailSummary,
  MangaListItem,
  MangaChapterRecord,
  MangaWithDetails,
  MangaCategoryLink,
  MigrationSummary,
  MigrateMangaOptions,
  LinkedTitle,
  MangaLinkGroup,
} from '@projekt-manga/types';

// Local-first sort options are intentionally ignored below: the desktop local DB is
// small enough (one person's own library) that server-side sorting isn't worth
// replicating yet — see apps/desktop/src/main/db/local-store.ts's listLibrary(), which
// always orders by title. Revisit if that stops being true.
/** HTTP-only view of this session's server library, including on desktop. */
export const getServerManga = (options: GetMangaOptions = {}, signal?: AbortSignal) =>
  fetchAllPages((page) =>
    request<MangaListItem[]>('/manga', {
      query: { sortBy: options.sortBy, sortOrder: options.sortOrder, ...page },
      signal,
    }),
  );

export const getManga = async (options: GetMangaOptions = {}, signal?: AbortSignal) => {
  if (await usesLocalFirstData()) {
    // localInvoke has no AbortSignal parameter — `signal` is silently dropped on this
    // branch, so cancellation is only honoured on the HTTP path below. A caller relying on
    // abort here keeps waiting on desktop.
    return localInvoke<MangaListItem[]>('manga', 'listLibrary');
  }
  return getServerManga(options, signal);
};

export const getMangaById = (mangaId: string, signal?: AbortSignal) =>
  request<Manga | null>(`/manga/${encodeURIComponent(mangaId)}`, { signal });

export const getMangaDetailsById = async (
  mangaId: string,
  signal?: AbortSignal,
  sessionToken?: string,
) => {
  if (await usesLocalFirstData()) {
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
 * `getManga` above reads the library from the local database on a signed-in desktop, but writes go
 * only to the API. Without mirroring, a title added mid-session stays invisible until the
 * next app start re-seeds, and re-adding it fails because the API already has the row.
 *
 * Deliberately best-effort: the HTTP write has already succeeded and is the source of
 * truth by the time this runs, so a failure here must not turn a successful add into a
 * reported failure. A later retry can reconcile that exact title from the server library.
 */
async function mirrorLibraryWrite(mangaId: string, inLibrary: boolean): Promise<boolean> {
  if (!(await usesLocalFirstData())) return true;
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
      !(await usesLocalFirstData())
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

/** Saves edits to a title for this reader only; the shared catalog is untouched. */
export const updateMangaOverride = (mangaId: string, payload: UpdateMangaOverridePayload) =>
  request<MangaOverrideRecord | null>(`/manga/${encodeURIComponent(mangaId)}/override`, {
    method: 'PATCH',
    body: payload,
  });

/** "Reset to source": drops every edit to the title, the custom cover included. */
export const resetMangaOverride = (mangaId: string) =>
  request<null>(`/manga/${encodeURIComponent(mangaId)}/override`, { method: 'DELETE' });

const toBase64 = async (file: Blob) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // Chunked: spreading a multi-megabyte array into one call overflows the stack.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/** Uploads a custom cover (JPEG, PNG, GIF, WebP or AVIF, at most 5 MB). It is sent as
 * base64 in JSON, the only body type the server accepts for a write. */
export const uploadMangaCover = async (mangaId: string, file: Blob) =>
  request<MangaOverrideRecord | null>(`/manga/${encodeURIComponent(mangaId)}/override/cover`, {
    method: 'POST',
    body: { mime: file.type, data: await toBase64(file) },
    timeoutMs: 120_000,
  });

/** Goes back to the source's cover, keeping any other edits. */
export const removeMangaCover = (mangaId: string) =>
  request<MangaOverrideRecord | null>(`/manga/${encodeURIComponent(mangaId)}/override/cover`, {
    method: 'DELETE',
  });

const linksPath = (mangaId: string) => `/manga/${encodeURIComponent(mangaId)}/links`;

export const getMangaLinks = (mangaId: string, signal?: AbortSignal) =>
  request<MangaLinkGroup>(linksPath(mangaId), { signal });

/** Every group of this identity, for library updates (linked titles are checked too). */
export const getAllMangaLinks = (signal?: AbortSignal) =>
  request<Array<{ primary_id: string; linked: LinkedTitle[] }>>('/manga/links/all', { signal });

export const linkMangaSource = (mangaId: string, linkedMangaId: string) =>
  request<MangaLinkGroup>(linksPath(mangaId), {
    method: 'POST',
    body: { linked_manga_id: linkedMangaId },
  });

export const reorderMangaLinks = (mangaId: string, linkIds: string[]) =>
  request<MangaLinkGroup>(`${linksPath(mangaId)}/order`, {
    method: 'PUT',
    body: { link_ids: linkIds },
  });

export const unlinkMangaSource = (mangaId: string, linkId: string) =>
  request<MangaLinkGroup>(`${linksPath(mangaId)}/${encodeURIComponent(linkId)}`, {
    method: 'DELETE',
  });
