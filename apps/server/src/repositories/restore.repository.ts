import prisma from '../configs/prisma.config.js';
import { isMangaStatus } from '@projekt-manga/types';
import { backupChapterKey } from '@projekt-manga/schemas';
import type { PreviewBackupBody, ReplaceBackupBody } from '@projekt-manga/schemas';
import { Prisma } from '@prisma/client';
import { randomUUID as createId } from 'node:crypto';
import mangaOverrideRepository from './mangaOverride.repository.js';
import mangaLinkRepository from './mangaLink.repository.js';
import { ValidationError } from '../utils/customErrors.js';
import restoreJobRepository from './restoreJob.repository.js';

const LOOKUP_CHUNK_SIZE = 200;
const INSERT_CHUNK_SIZE = 50;
/** 17 bound values a row, well under SQLite's 32766 per statement. */
const CHAPTER_INSERT_CHUNK_SIZE = 500;

type ExistingRestoreChapter = {
  id: string;
  manga_id: string | null;
  last_page_read: number;
  is_read: boolean;
  is_bookmark: boolean;
};

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

type RestoredChapterRow = Omit<
  Prisma.chapterCreateManyInput,
  'release_date' | 'fetched_at' | 'created_at' | 'updated_at'
> & { release_date: Date | null };

/**
 * Inserts restored chapters with parameterised multi-row INSERTs. A backup can hold 50,000
 * chapters, and `createMany` spends most of a restore's time building its queries; this
 * writes the same rows (Prisma's defaults, both timestamps now) in a fraction of it.
 */
async function insertChapters(tx: Prisma.TransactionClient, rows: RestoredChapterRow[]) {
  const now = new Date();
  for (const group of chunks(rows, CHAPTER_INSERT_CHUNK_SIZE)) {
    const values = group.map(
      (row) =>
        Prisma.sql`(${row.id}, ${row.source}, ${row.manga_slug}, ${row.source_chapter_key},
          ${row.manga_id ?? null}, ${row.url}, ${row.name ?? null}, ${row.scanlator ?? null},
          ${row.is_read ?? false}, ${row.is_bookmark ?? false}, ${row.chapter_number},
          ${row.last_page_read ?? 0}, ${row.page_count ?? null}, ${null}, ${row.release_date},
          ${now}, ${now})`,
    );
    await tx.$executeRaw`INSERT INTO "chapters" ("id", "source", "manga_slug",
      "source_chapter_key", "manga_id", "url", "name", "scanlator", "is_read", "is_bookmark",
      "chapter_number", "last_page_read", "page_count", "fetched_at", "release_date",
      "created_at", "updated_at") VALUES ${Prisma.join(values)}`;
  }
}

function mangaKey(source: string, slug: string): string {
  return `${source}\0${slug}`;
}

/** A chapter as backups name it: the source's key within its title. */
function chapterKey(source: string, slug: string, key: string): string {
  return `${source}\0${slug}\0${key}`;
}

/** Backups written before chapters had their own key carried it as `chapter_id`. */
function historyChapterKey(row: {
  source_chapter_key?: string | null;
  chapter_id?: string | null;
}): string | null {
  return row.source_chapter_key ?? row.chapter_id ?? null;
}

function historyKey(row: { source: string; manga_slug: string }, key: string | null): string {
  return `${row.source}\0${row.manga_slug}\0${key ?? ''}`;
}

/** Stored chapters for the given title-scoped keys, in bounded queries. */
type BackupTitle = ReplaceBackupBody['manga'][number];

/**
 * A backed-up title as the shared catalog should store it.
 *
 * An export reads titles through the details endpoint, which lays the owner's edits over the
 * catalog, so an edited entry's title/author/description/status are the edited values. Its
 * `override.original` carries the catalog's own; restoring those keeps an edit out of the
 * shared row, and the edit itself goes back into manga_overrides afterwards.
 */
function catalogEntry<T extends Pick<BackupTitle, 'title' | 'author' | 'description' | 'status'>>(
  entry: T & { override?: BackupTitle['override'] },
): T {
  const original = entry.override?.original;
  if (!original) return entry;
  return {
    ...entry,
    title: original.title,
    author: original.author,
    description: original.description ?? entry.description,
    status: original.status ?? entry.status,
  };
}

async function findChaptersByKey(
  db: Pick<typeof prisma, 'chapter'>,
  refs: Array<{ source: string; manga_slug: string; source_chapter_key: string }>,
) {
  const byTitle = new Map<string, { source: string; manga_slug: string; keys: string[] }>();
  for (const ref of refs) {
    const title = mangaKey(ref.source, ref.manga_slug);
    const group = byTitle.get(title) ?? {
      source: ref.source,
      manga_slug: ref.manga_slug,
      keys: [],
    };
    group.keys.push(ref.source_chapter_key);
    byTitle.set(title, group);
  }
  const found = new Map<string, ExistingRestoreChapter>();
  for (const { source, manga_slug, keys } of byTitle.values()) {
    for (const group of chunks([...new Set(keys)], LOOKUP_CHUNK_SIZE)) {
      const rows = await db.chapter.findMany({
        where: { source, manga_slug, source_chapter_key: { in: group } },
        select: {
          id: true,
          manga_id: true,
          last_page_read: true,
          is_read: true,
          is_bookmark: true,
          source_chapter_key: true,
        },
      });
      for (const { source_chapter_key, ...row } of rows) {
        found.set(chapterKey(source, manga_slug, source_chapter_key), row);
      }
    }
  }
  return found;
}

export async function previewBackupConflicts(input: PreviewBackupBody, userId?: string) {
  const backup = { ...input, manga: input.manga.map(catalogEntry) };
  const identities = new Map(
    backup.manga.map((entry) => [mangaKey(entry.source, entry.slug), entry]),
  );
  const existingManga = new Map<
    string,
    {
      id: string;
      source: string;
      slug: string;
      in_library: boolean;
      title: string;
      author: string;
      thumbnail_url: string;
    }
  >();
  for (const group of chunks([...identities.values()], LOOKUP_CHUNK_SIZE)) {
    const rows = await prisma.manga.findMany({
      where: { OR: group.map(({ source, slug }) => ({ source, slug })) },
      select: {
        id: true,
        source: true,
        slug: true,
        in_library: true,
        title: true,
        author: true,
        thumbnail_url: true,
      },
    });
    for (const row of rows) existingManga.set(mangaKey(row.source, row.slug), row);
  }

  const membershipIds = [...new Set([...existingManga.values()].map((row) => row.id))];
  const activeMemberships = new Set<string>();
  if (userId) {
    for (const group of chunks(membershipIds, LOOKUP_CHUNK_SIZE)) {
      const rows = await prisma.user_library.findMany({
        where: { user_id: userId, manga_id: { in: group }, deleted_at: null },
        select: { manga_id: true },
      });
      for (const row of rows) activeMemberships.add(row.manga_id);
    }
  }
  const matchingEntries = backup.manga.filter((entry) =>
    existingManga.has(mangaKey(entry.source, entry.slug)),
  );
  const entriesToRestore = backup.manga.filter((entry) => {
    if (backup.mode === 'replace') return true;
    const existing = existingManga.get(mangaKey(entry.source, entry.slug));
    const alreadyInLibrary =
      existing && (userId ? activeMemberships.has(existing.id) : existing.in_library);
    return !alreadyInLibrary;
  });

  const catalogRowsToUpdate = new Map<string, string>();
  const importedMangaIds: string[] = [];
  for (const entry of entriesToRestore) {
    const existing = existingManga.get(mangaKey(entry.source, entry.slug));
    if (existing) importedMangaIds.push(existing.id);
    if (
      existing &&
      (existing.title !== entry.title ||
        existing.author !== entry.author ||
        existing.thumbnail_url !== entry.thumbnail_url)
    ) {
      catalogRowsToUpdate.set(entry.id, `${entry.source} · ${entry.slug}: ${entry.title}`);
    }
  }
  const detailsByMangaId = new Map<
    string,
    {
      artist: string;
      description: string;
      genres: string;
      status: string;
      rating: number | null;
    }
  >();
  for (const group of chunks(importedMangaIds, LOOKUP_CHUNK_SIZE)) {
    const rows = await prisma.manga_detail.findMany({
      where: { manga_id: { in: group } },
      select: {
        manga_id: true,
        artist: true,
        description: true,
        genres: true,
        status: true,
        rating: true,
      },
    });
    for (const row of rows) detailsByMangaId.set(row.manga_id, row);
  }
  for (const entry of entriesToRestore) {
    const mangaId = existingManga.get(mangaKey(entry.source, entry.slug))?.id;
    const detail = mangaId ? detailsByMangaId.get(mangaId) : undefined;
    const status = entry.status.trim().toUpperCase();
    const normalizedStatus = isMangaStatus(status) ? status : 'UNKNOWN';
    if (
      mangaId &&
      (!detail ||
        detail.artist !== (entry.artist ?? 'Unknown') ||
        detail.description !== entry.description ||
        detail.genres !== entry.genres ||
        detail.status !== normalizedStatus ||
        detail.rating !== entry.rating)
    ) {
      catalogRowsToUpdate.set(entry.id, `${entry.source} · ${entry.slug}: ${entry.title}`);
    }
  }

  const historyKeys = new Set<string>();
  if (backup.mode !== 'replace') {
    const titles = [
      ...new Map(
        backup.history.map((row) => [
          mangaKey(row.source, row.manga_slug),
          { source: row.source, manga_slug: row.manga_slug },
        ]),
      ).values(),
    ];
    for (const group of chunks(titles, 100)) {
      const rows = await prisma.history.findMany({
        where: { user_id: userId ?? null, deleted_at: null, OR: group },
        select: {
          source: true,
          manga_slug: true,
          chapter: { select: { source_chapter_key: true } },
        },
      });
      for (const row of rows) {
        historyKeys.add(historyKey(row, row.chapter?.source_chapter_key ?? null));
      }
    }
  }
  let retainedHistory = 0;
  for (const row of backup.history) {
    const key = historyKey(row, historyChapterKey(row));
    if (historyKeys.has(key)) retainedHistory++;
    historyKeys.add(key);
  }

  return {
    matchingTitles: matchingEntries.length,
    addedTitles: backup.manga.length - matchingEntries.length,
    importedTitles: entriesToRestore.length,
    catalogRowsUpdated: catalogRowsToUpdate.size,
    catalogUpdateExamples: [...catalogRowsToUpdate.values()].slice(0, 20),
    retainedHistory,
    addedHistory: backup.history.length - retainedHistory,
  };
}

/** All account-visible replacement writes share one SQLite transaction. Catalog rows are
 * retained because another account, a download, or a source-only read may reference them. */
export async function replaceBackup(
  input: ReplaceBackupBody,
  userId?: string,
  jobId?: string,
  onProgress?: (completed: number, total: number, phase: string) => void,
) {
  const backup = { ...input, manga: input.manga.map(catalogEntry) };
  return prisma.$transaction(
    async (tx) => {
      const now = new Date();
      const replacing = backup.mode === 'replace';
      if (replacing && userId) {
        await tx.user_library.updateMany({
          where: { user_id: userId, deleted_at: null },
          data: { deleted_at: now, edited_at: null },
        });
        await tx.user_manga_state.deleteMany({ where: { user_id: userId } });
        await tx.user_chapter_state.deleteMany({ where: { user_id: userId } });
        await tx.history.updateMany({
          where: { user_id: userId, deleted_at: null },
          data: { deleted_at: now, sync_updated_at: now },
        });
      } else if (replacing) {
        await tx.manga.updateMany({ where: { in_library: true }, data: { in_library: false } });
        await tx.manga_library.deleteMany();
        await tx.chapter.updateMany({
          where: { OR: [{ is_read: true }, { is_bookmark: true }, { last_page_read: { gt: 0 } }] },
          data: { is_read: false, is_bookmark: false, last_page_read: 0 },
        });
        await tx.history.deleteMany({ where: { user_id: null } });
      }
      if (replacing) {
        // A custom cover is a file a backup does not carry, so it survives a replace;
        // every text edit is replaced by the backup's.
        await tx.manga_override.updateMany({
          where: { user_id: userId ?? null },
          data: { title: null, author: null, description: null, status: null },
        });
        await tx.manga_override.deleteMany({
          where: { user_id: userId ?? null, cover_path: null },
        });
        // Linked sources are replaced by the backup's.
        await tx.manga_link.deleteMany({ where: { user_id: userId ?? null } });
      }

      const idMap = new Map<string, string>();
      const savedPositionIds = new Set<string>();
      const existingImportIds = new Set<string>();
      let restoredManga = 0;
      const progressTotal =
        backup.manga.length +
        backup.library.length +
        backup.history.length +
        backup.manga.reduce((sum, entry) => sum + entry.chapters.length, 0);
      let progressCompleted = 0;
      const reportProgress = (phase: string) =>
        onProgress?.(++progressCompleted, progressTotal, phase);
      onProgress?.(0, progressTotal, 'Preparing restore');

      // Resolve identities in bounded queries before the per-row writes. This reduces
      // SQLite round trips while staying below its common bound-parameter limit.
      const mangaIdentities = new Map<string, { source: string; slug: string }>();
      for (const entry of backup.manga) {
        mangaIdentities.set(mangaKey(entry.source, entry.slug), {
          source: entry.source,
          slug: entry.slug,
        });
      }
      const existingMangaByKey = new Map<
        string,
        {
          id: string;
          source: string;
          slug: string;
          in_library: boolean;
          title: string;
          author: string;
          thumbnail_url: string;
        }
      >();
      for (const group of chunks([...mangaIdentities.values()], LOOKUP_CHUNK_SIZE)) {
        const rows = await tx.manga.findMany({
          where: { OR: group.map(({ source, slug }) => ({ source, slug })) },
          select: {
            id: true,
            source: true,
            slug: true,
            in_library: true,
            title: true,
            author: true,
            thumbnail_url: true,
          },
        });
        for (const row of rows) existingMangaByKey.set(mangaKey(row.source, row.slug), row);
      }
      const existingMembershipByMangaId = new Map<string, { deleted_at: Date | null }>();
      if (userId) {
        const ids = [...new Set([...existingMangaByKey.values()].map((row) => row.id))];
        for (const group of chunks(ids, LOOKUP_CHUNK_SIZE)) {
          const rows = await tx.user_library.findMany({
            where: { user_id: userId, manga_id: { in: group } },
            select: { manga_id: true, deleted_at: true },
          });
          for (const row of rows) {
            existingMembershipByMangaId.set(row.manga_id, { deleted_at: row.deleted_at });
          }
        }
      }
      const entriesToRestore: typeof backup.manga = [];
      const newMangaKeys = new Set<string>();
      for (const entry of backup.manga) {
        const key = mangaKey(entry.source, entry.slug);
        const existingManga = existingMangaByKey.get(key);
        const membership = existingManga ? existingMembershipByMangaId.get(existingManga.id) : null;
        const alreadyInLibrary =
          existingManga &&
          (userId ? !!membership && membership.deleted_at === null : existingManga.in_library);
        if (!replacing && alreadyInLibrary) {
          idMap.set(entry.id, existingManga.id);
          existingImportIds.add(entry.id);
        } else {
          entriesToRestore.push(entry);
          if (!existingManga) newMangaKeys.add(key);
        }
      }

      const mangaCreateRows: Prisma.mangaCreateManyInput[] = entriesToRestore
        .filter((entry) => newMangaKeys.has(mangaKey(entry.source, entry.slug)))
        .map((entry) => ({
          source: entry.source,
          slug: entry.slug,
          title: entry.title,
          author: entry.author,
          thumbnail_url: entry.thumbnail_url,
          in_library: !userId,
        }));
      for (const group of chunks(mangaCreateRows, INSERT_CHUNK_SIZE)) {
        await tx.manga.createMany({ data: group });
      }
      if (mangaCreateRows.length > 0) {
        existingMangaByKey.clear();
        for (const group of chunks([...mangaIdentities.values()], LOOKUP_CHUNK_SIZE)) {
          const rows = await tx.manga.findMany({
            where: { OR: group.map(({ source, slug }) => ({ source, slug })) },
            select: {
              id: true,
              source: true,
              slug: true,
              in_library: true,
              title: true,
              author: true,
              thumbnail_url: true,
            },
          });
          for (const row of rows) existingMangaByKey.set(mangaKey(row.source, row.slug), row);
        }
      }

      const detailByMangaId = new Map<
        string,
        {
          artist: string;
          description: string;
          genres: string;
          status: string;
          rating: number | null;
        }
      >();
      const restoredMangaIds = entriesToRestore.map(
        (entry) => existingMangaByKey.get(mangaKey(entry.source, entry.slug))!.id,
      );
      for (const group of chunks(restoredMangaIds, LOOKUP_CHUNK_SIZE)) {
        const rows = await tx.manga_detail.findMany({
          where: { manga_id: { in: group } },
          select: {
            manga_id: true,
            artist: true,
            description: true,
            genres: true,
            status: true,
            rating: true,
          },
        });
        for (const row of rows) detailByMangaId.set(row.manga_id, row);
      }
      const detailCreateRows: Prisma.manga_detailCreateManyInput[] = [];
      const newDetailIds = new Set<string>();
      for (const entry of entriesToRestore) {
        const mangaId = existingMangaByKey.get(mangaKey(entry.source, entry.slug))!.id;
        if (detailByMangaId.has(mangaId)) continue;
        const status = entry.status.trim().toUpperCase();
        detailCreateRows.push({
          manga_id: mangaId,
          artist: entry.artist ?? 'Unknown',
          description: entry.description,
          genres: entry.genres,
          status: isMangaStatus(status) ? status : 'UNKNOWN',
          rating: entry.rating,
        });
        newDetailIds.add(mangaId);
      }
      for (const group of chunks(detailCreateRows, INSERT_CHUNK_SIZE)) {
        await tx.manga_detail.createMany({ data: group });
      }

      const existingChapterByKey = await findChaptersByKey(tx, [
        ...backup.manga.flatMap((entry) =>
          entry.chapters.map((chapter) => ({
            source: entry.source,
            manga_slug: entry.slug,
            source_chapter_key: backupChapterKey(chapter),
          })),
        ),
        ...backup.history.flatMap((row) => {
          const key = historyChapterKey(row);
          return key
            ? [{ source: row.source, manga_slug: row.manga_slug, source_chapter_key: key }]
            : [];
        }),
      ]);
      const chapterCreateRows: RestoredChapterRow[] = [];
      const userChapterStateRows: Prisma.user_chapter_stateCreateManyInput[] = [];
      let restoredChapterCount = 0;

      for (const entry of backup.manga) {
        const key = mangaKey(entry.source, entry.slug);
        if (existingImportIds.has(entry.id)) {
          reportProgress('Restoring titles');
          restoredChapterCount += entry.chapters.length;
          continue;
        }
        restoredManga += 1;
        const manga = existingMangaByKey.get(key);
        if (!manga) throw new Error('Missing restored manga identity');
        const needsMangaUpdate =
          manga.title !== entry.title ||
          manga.author !== entry.author ||
          manga.thumbnail_url !== entry.thumbnail_url ||
          (!userId && !manga.in_library);
        if (!newMangaKeys.has(key) && needsMangaUpdate) {
          await tx.manga.update({
            where: { id: manga.id },
            data: {
              title: entry.title,
              author: entry.author,
              thumbnail_url: entry.thumbnail_url,
              ...(!userId ? { in_library: true } : {}),
            },
          });
        }
        idMap.set(entry.id, manga.id);
        const status = entry.status.trim().toUpperCase();
        const normalizedStatus = isMangaStatus(status) ? status : 'UNKNOWN';
        const existingDetail = detailByMangaId.get(manga.id);
        if (
          existingDetail &&
          !newDetailIds.has(manga.id) &&
          (existingDetail.artist !== (entry.artist ?? 'Unknown') ||
            existingDetail.description !== entry.description ||
            existingDetail.genres !== entry.genres ||
            existingDetail.status !== normalizedStatus ||
            existingDetail.rating !== entry.rating)
        ) {
          await tx.manga_detail.update({
            where: { manga_id: manga.id },
            data: {
              artist: entry.artist ?? 'Unknown',
              description: entry.description,
              genres: entry.genres,
              status: normalizedStatus,
              rating: entry.rating,
            },
          });
        }
        if (userId) {
          await tx.user_library.upsert({
            where: { user_id_manga_id: { user_id: userId, manga_id: manga.id } },
            create: { user_id: userId, manga_id: manga.id },
            update: { deleted_at: null, edited_at: null },
          });
        }
        for (const chapter of entry.chapters) {
          const releaseDate = chapter.release_date ? new Date(chapter.release_date) : null;
          const catalog = {
            url: chapter.url,
            name: chapter.name,
            scanlator: chapter.scanlator ?? null,
            chapter_number: chapter.chapter_number,
            page_count: chapter.page_count,
            release_date: releaseDate,
          };
          const key = chapterKey(entry.source, entry.slug, backupChapterKey(chapter));
          const existing = existingChapterByKey.get(key);
          // A replace starts from cleared state, so the backup's is the state. A merge keeps
          // what this library already has and adds the backup's on top: the further page,
          // read if either says read. Overwriting turned read chapters unread when a title
          // outside the library had been read here.
          const mergedState =
            !replacing && existing
              ? {
                  is_read: existing.is_read || chapter.is_read,
                  is_bookmark: existing.is_bookmark || chapter.is_bookmark,
                  last_page_read: Math.max(existing.last_page_read, chapter.last_page_read),
                }
              : {
                  is_read: chapter.is_read,
                  is_bookmark: chapter.is_bookmark,
                  last_page_read: chapter.last_page_read,
                };
          const restoredState = !userId ? mergedState : {};
          // Row ids are this server's own: a backup's ids belong to the server or device
          // that wrote it, so a new row always gets a fresh one.
          const id = existing?.id ?? createId();
          if (existing) {
            await tx.chapter.update({
              where: { id },
              data: { manga_id: manga.id, ...catalog, ...restoredState },
            });
          } else {
            chapterCreateRows.push({
              id,
              source: entry.source,
              manga_slug: entry.slug,
              source_chapter_key: backupChapterKey(chapter),
              manga_id: manga.id,
              ...catalog,
              ...restoredState,
            });
          }
          existingChapterByKey.set(key, {
            id,
            manga_id: manga.id,
            last_page_read: userId ? (existing?.last_page_read ?? 0) : mergedState.last_page_read,
            is_read: userId ? (existing?.is_read ?? false) : mergedState.is_read,
            is_bookmark: userId ? (existing?.is_bookmark ?? false) : mergedState.is_bookmark,
          });
          if (userId && (chapter.is_read || chapter.is_bookmark || chapter.last_page_read > 0)) {
            userChapterStateRows.push({
              user_id: userId,
              chapter_id: id,
              is_read: chapter.is_read,
              is_bookmark: chapter.is_bookmark,
              last_page_read: chapter.last_page_read,
            });
          }
          if (chapter.last_page_read > 0) savedPositionIds.add(id);
          restoredChapterCount += 1;
        }
        reportProgress('Restoring titles');
      }
      await insertChapters(tx, chapterCreateRows);
      // A replace cleared this account's chapter state above. A merge may meet rows that
      // are already there: a title read from a source, or removed from the library (which
      // keeps its reading). Inserting those failed on the unique key and rolled the whole
      // restore back, so they are combined instead: the further page, read if either is.
      const existingUserChapterState = new Map<
        string,
        { is_read: boolean; is_bookmark: boolean; last_page_read: number }
      >();
      if (userId && !replacing) {
        const chapterIds = userChapterStateRows.map((row) => row.chapter_id);
        for (const group of chunks(chapterIds, LOOKUP_CHUNK_SIZE)) {
          const rows = await tx.user_chapter_state.findMany({
            where: { user_id: userId, chapter_id: { in: group } },
            select: { chapter_id: true, is_read: true, is_bookmark: true, last_page_read: true },
          });
          for (const { chapter_id, ...state } of rows) {
            existingUserChapterState.set(chapter_id, state);
          }
        }
      }
      for (const row of userChapterStateRows) {
        const current = existingUserChapterState.get(row.chapter_id);
        if (!current) continue;
        await tx.user_chapter_state.update({
          where: { user_id_chapter_id: { user_id: row.user_id, chapter_id: row.chapter_id } },
          data: {
            is_read: current.is_read || Boolean(row.is_read),
            is_bookmark: current.is_bookmark || Boolean(row.is_bookmark),
            last_page_read: Math.max(current.last_page_read, row.last_page_read ?? 0),
          },
        });
      }
      const newUserChapterState = userChapterStateRows.filter(
        (row) => !existingUserChapterState.has(row.chapter_id),
      );
      for (const group of chunks(newUserChapterState, INSERT_CHUNK_SIZE)) {
        await tx.user_chapter_state.createMany({ data: group });
      }
      for (let index = 0; index < restoredChapterCount; index++) {
        reportProgress('Restoring chapters');
      }

      const mangaLibraryRows: Prisma.manga_libraryCreateManyInput[] = [];
      const userMangaStateRows: Prisma.user_manga_stateCreateManyInput[] = [];
      for (const state of backup.library) {
        if (existingImportIds.has(state.manga_id)) {
          reportProgress('Restoring library state');
          continue;
        }
        const mangaId = idMap.get(state.manga_id);
        if (!mangaId) throw new Error('Missing title for library state');
        if (userId) {
          userMangaStateRows.push({
            user_id: userId,
            manga_id: mangaId,
            is_bookmarked: state.is_bookmarked,
            shelf_status: state.shelf_status,
            notification_read: state.notification_read,
            score: state.score ?? null,
          });
        } else {
          mangaLibraryRows.push({
            manga_id: mangaId,
            is_bookmarked: state.is_bookmarked,
            shelf_status: state.shelf_status,
            notification_read: state.notification_read,
          });
        }
      }
      // As with chapter state: a merge may meet a title's state row that outlived its
      // removal from the library (an account's, or the anonymous library's once an account
      // had tracked the title). The backup's state is applied to it rather than inserted
      // beside it, keeping a bookmark either side set.
      if (userId) {
        const existingIds = new Set<string>();
        if (!replacing) {
          for (const group of chunks(
            userMangaStateRows.map((row) => row.manga_id),
            LOOKUP_CHUNK_SIZE,
          )) {
            const rows = await tx.user_manga_state.findMany({
              where: { user_id: userId, manga_id: { in: group } },
              select: { manga_id: true, is_bookmarked: true },
            });
            for (const row of rows) {
              existingIds.add(row.manga_id);
              const incoming = userMangaStateRows.find((state) => state.manga_id === row.manga_id)!;
              await tx.user_manga_state.update({
                where: { user_id_manga_id: { user_id: userId, manga_id: row.manga_id } },
                data: {
                  is_bookmarked: row.is_bookmarked || Boolean(incoming.is_bookmarked),
                  shelf_status: incoming.shelf_status,
                  notification_read: incoming.notification_read,
                  score: incoming.score,
                },
              });
            }
          }
        }
        const fresh = userMangaStateRows.filter((row) => !existingIds.has(row.manga_id));
        for (const group of chunks(fresh, INSERT_CHUNK_SIZE)) {
          await tx.user_manga_state.createMany({ data: group });
        }
      } else {
        const existingIds = new Set<string>();
        if (!replacing) {
          for (const group of chunks(
            mangaLibraryRows.map((row) => row.manga_id),
            LOOKUP_CHUNK_SIZE,
          )) {
            const rows = await tx.manga_library.findMany({
              where: { manga_id: { in: group } },
              select: { manga_id: true, is_bookmarked: true },
            });
            for (const row of rows) {
              existingIds.add(row.manga_id);
              const incoming = mangaLibraryRows.find((state) => state.manga_id === row.manga_id)!;
              await tx.manga_library.update({
                where: { manga_id: row.manga_id },
                data: {
                  is_bookmarked: row.is_bookmarked || Boolean(incoming.is_bookmarked),
                  shelf_status: incoming.shelf_status,
                  notification_read: incoming.notification_read,
                },
              });
            }
          }
        }
        const fresh = mangaLibraryRows.filter((row) => !existingIds.has(row.manga_id));
        for (const group of chunks(fresh, INSERT_CHUNK_SIZE)) {
          await tx.manga_library.createMany({ data: group });
        }
      }
      for (let index = 0; index < userMangaStateRows.length + mangaLibraryRows.length; index++) {
        reportProgress('Restoring library state');
      }
      for (const entry of backup.manga) {
        const edit = entry.override;
        const mangaId = idMap.get(entry.id);
        if (!edit || !mangaId) continue;
        const fields = {
          title: edit.title,
          author: edit.author,
          description: edit.description,
          status: edit.status && isMangaStatus(edit.status) ? edit.status : null,
        };
        // Merging keeps an edit made here since the backup; only unset fields are filled.
        const current = replacing
          ? null
          : await mangaOverrideRepository.find(mangaId, userId ?? null, tx);
        await mangaOverrideRepository.upsert(
          mangaId,
          userId ?? null,
          current
            ? {
                title: current.title ?? fields.title,
                author: current.author ?? fields.author,
                description: current.description ?? fields.description,
                status: current.status ?? fields.status,
              }
            : fields,
          tx,
        );
      }
      // Linked sources, after every title is in place. A linked title the server no longer
      // has comes back as a catalog row outside the library (its chapters arrive with the
      // next library update). A link the rules refuse (a chain, a title already linked
      // elsewhere when merging) is left out rather than failing the restore.
      for (const entry of backup.manga) {
        const primaryId = idMap.get(entry.id);
        if (!primaryId || !entry.links?.length) continue;
        for (const link of [...entry.links].sort((a, b) => a.priority - b.priority)) {
          const linked =
            (await tx.manga.findUnique({
              where: { source_slug: { source: link.source, slug: link.slug } },
              select: { id: true },
            })) ??
            (await tx.manga.create({
              data: {
                source: link.source,
                slug: link.slug,
                title: link.title,
                author: link.author,
                thumbnail_url: link.thumbnail_url,
                in_library: false,
              },
              select: { id: true },
            }));
          try {
            await mangaLinkRepository.create(primaryId, linked.id, userId ?? null, tx);
          } catch (error) {
            if (!(error instanceof ValidationError)) throw error;
          }
        }
      }
      const existingHistory = replacing
        ? new Set<string>()
        : new Set(
            (
              await tx.history.findMany({
                where: { user_id: userId ?? null, deleted_at: null },
                select: {
                  source: true,
                  manga_slug: true,
                  chapter: { select: { source_chapter_key: true } },
                },
              })
            ).map((row) => historyKey(row, row.chapter?.source_chapter_key ?? null)),
          );
      let restoredHistory = 0;
      const historyCreateRows: Prisma.historyCreateManyInput[] = [];
      for (const row of backup.history) {
        const sourceChapterKey = historyChapterKey(row);
        const rowKey = historyKey(row, sourceChapterKey);
        if (existingHistory.has(rowKey)) {
          reportProgress('Restoring reading history');
          continue;
        }
        existingHistory.add(rowKey);
        restoredHistory += 1;
        const mangaId = row.manga_id ? (idMap.get(row.manga_id) ?? null) : null;
        let chapterId: string | null = null;
        if (sourceChapterKey) {
          const key = chapterKey(row.source, row.manga_slug, sourceChapterKey);
          let chapter = existingChapterByKey.get(key) ?? null;
          chapterId = chapter?.id ?? createId();
          if (row.last_page_read > 0) savedPositionIds.add(chapterId);
          if (!chapter) {
            await tx.chapter.create({
              data: {
                id: chapterId,
                source: row.source,
                manga_slug: row.manga_slug,
                source_chapter_key: sourceChapterKey,
                manga_id: mangaId,
                url: '',
                name: '',
                chapter_number: row.chapter_number ?? 0,
                page_count: row.page_count ?? null,
              },
            });
            chapter = {
              id: chapterId,
              manga_id: mangaId,
              last_page_read: 0,
              is_read: false,
              is_bookmark: false,
            };
            existingChapterByKey.set(key, chapter);
          }
          if (row.last_page_read > 0 || row.is_read) {
            if (userId) {
              const current = await tx.user_chapter_state.findUnique({
                where: { user_id_chapter_id: { user_id: userId, chapter_id: chapterId } },
                select: { last_page_read: true, is_read: true },
              });
              await tx.user_chapter_state.upsert({
                where: { user_id_chapter_id: { user_id: userId, chapter_id: chapterId } },
                create: {
                  user_id: userId,
                  chapter_id: chapterId,
                  last_page_read: row.last_page_read,
                  is_read: row.is_read ?? false,
                },
                update: {
                  last_page_read: Math.max(current?.last_page_read ?? 0, row.last_page_read),
                  is_read: (current?.is_read ?? false) || (row.is_read ?? false),
                },
              });
            } else {
              const lastPageRead = Math.max(chapter?.last_page_read ?? 0, row.last_page_read);
              const isRead = (chapter?.is_read ?? false) || (row.is_read ?? false);
              await tx.chapter.update({
                where: { id: chapterId },
                data: { last_page_read: lastPageRead, is_read: isRead },
              });
              existingChapterByKey.set(key, {
                ...chapter,
                last_page_read: lastPageRead,
                is_read: isRead,
              });
            }
          }
        }
        historyCreateRows.push({
          source: row.source,
          manga_id: mangaId,
          manga_slug: row.manga_slug,
          source_manga_id: row.source_manga_id ?? null,
          chapter_id: chapterId,
          user_id: userId ?? null,
          title: row.title ?? null,
          thumbnail_url: row.thumbnail_url ?? null,
          pages_read: row.pages_read,
          time_read: row.time_read ?? 0,
          read_at: new Date(row.read_at),
          last_read: new Date(row.last_read),
          sync_updated_at: now,
        });
      }
      for (const group of chunks(historyCreateRows, INSERT_CHUNK_SIZE)) {
        await tx.history.createMany({ data: group });
      }
      for (let index = 0; index < restoredHistory; index++) {
        reportProgress('Restoring reading history');
      }
      const result = {
        restoredManga: replacing ? backup.manga.length : restoredManga,
        restoredProgress: savedPositionIds.size,
        restoredHistory,
      };
      if (replacing && userId) {
        await tx.user.update({
          where: { id: userId },
          data: { sync_generation: { increment: 1 } },
        });
      }
      if (jobId) await restoreJobRepository.markSucceeded(tx, jobId, result);
      return result;
    },
    { maxWait: 15_000, timeout: restoreTimeoutMs(input) },
  );
}

/**
 * How long one restore's transaction may run before it is rolled back.
 *
 * A fixed two minutes failed large restores every time they were retried: restoring a
 * backup onto the server it came from updates every row it already has, a few database
 * round trips each. The allowance grows with the backup instead, from two minutes, at
 * a generous 10 ms per row, and is capped so a stuck restore still ends.
 */
export function restoreTimeoutMs(backup: Pick<ReplaceBackupBody, 'manga' | 'library' | 'history'>) {
  const rows =
    backup.manga.length +
    backup.library.length +
    backup.history.length +
    backup.manga.reduce((sum, entry) => sum + entry.chapters.length, 0);
  return Math.min(30 * 60_000, Math.max(120_000, rows * 10));
}
