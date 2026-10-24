import prisma from '../configs/prisma.config.js';
import { isMangaStatus } from '@projekt-manga/types';
import type { PreviewBackupBody, ReplaceBackupBody } from '@projekt-manga/schemas';
import type { Prisma } from '@prisma/client';

const LOOKUP_CHUNK_SIZE = 200;
const INSERT_CHUNK_SIZE = 50;

type ExistingRestoreChapter = {
  id: string;
  manga_id: string | null;
  last_page_read: number;
  is_read: boolean;
  manga: { source: string; slug: string } | null;
};

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

function mangaKey(source: string, slug: string): string {
  return `${source}\0${slug}`;
}

export async function previewBackupConflicts(backup: PreviewBackupBody, userId?: string) {
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

  const expectedChapterOwner = new Map<string, string>();
  const expectedChapterLabel = new Map<string, string>();
  const chapterIdentityConflictExamples: string[] = [];
  let chapterIdentityConflicts = 0;
  const recordExpectedChapterOwner = (id: string, owner: string, label: string) => {
    const previousOwner = expectedChapterOwner.get(id);
    if (previousOwner && previousOwner !== owner) {
      chapterIdentityConflicts++;
      if (chapterIdentityConflictExamples.length < 20) chapterIdentityConflictExamples.push(label);
      return;
    }
    expectedChapterOwner.set(id, owner);
    expectedChapterLabel.set(id, label);
  };
  for (const entry of entriesToRestore) {
    const owner = mangaKey(entry.source, entry.slug);
    for (const chapter of entry.chapters) {
      recordExpectedChapterOwner(
        chapter.id,
        owner,
        `${entry.title} (chapter ${chapter.chapter_number})`,
      );
    }
  }
  for (const row of backup.history) {
    if (row.chapter_id)
      recordExpectedChapterOwner(
        row.chapter_id,
        mangaKey(row.source, row.manga_slug),
        `History entry for ${row.title ?? row.manga_slug}`,
      );
  }

  const chapterIds = [...expectedChapterOwner.keys()];
  for (const group of chunks(chapterIds, LOOKUP_CHUNK_SIZE)) {
    const rows = await prisma.chapter.findMany({
      where: { id: { in: group } },
      select: { id: true, manga: { select: { source: true, slug: true } } },
    });
    for (const row of rows) {
      const expectedOwner = expectedChapterOwner.get(row.id);
      if (
        !row.manga ||
        !expectedOwner ||
        mangaKey(row.manga.source, row.manga.slug) === expectedOwner
      )
        continue;
      chapterIdentityConflicts++;
      if (chapterIdentityConflictExamples.length < 20) {
        chapterIdentityConflictExamples.push(expectedChapterLabel.get(row.id) ?? 'Unknown chapter');
      }
    }
  }

  const historyKeys = new Set<string>();
  if (backup.mode !== 'replace') {
    const historyIdentities = [
      ...new Map(
        backup.history.map((row) => [
          `${row.source}\0${row.manga_slug}\0${row.chapter_id ?? ''}`,
          { source: row.source, manga_slug: row.manga_slug, chapter_id: row.chapter_id ?? null },
        ]),
      ).values(),
    ];
    for (const group of chunks(historyIdentities, 100)) {
      const rows = await prisma.history.findMany({
        where: {
          user_id: userId ?? null,
          deleted_at: null,
          OR: group.map((identity) => ({
            source: identity.source,
            manga_slug: identity.manga_slug,
            chapter_id: identity.chapter_id,
          })),
        },
        select: { source: true, manga_slug: true, chapter_id: true },
      });
      for (const row of rows)
        historyKeys.add(`${row.source}\0${row.manga_slug}\0${row.chapter_id ?? ''}`);
    }
  }
  let retainedHistory = 0;
  for (const row of backup.history) {
    const key = `${row.source}\0${row.manga_slug}\0${row.chapter_id ?? ''}`;
    if (historyKeys.has(key)) retainedHistory++;
    historyKeys.add(key);
  }

  return {
    matchingTitles: matchingEntries.length,
    addedTitles: backup.manga.length - matchingEntries.length,
    importedTitles: entriesToRestore.length,
    catalogRowsUpdated: catalogRowsToUpdate.size,
    catalogUpdateExamples: [...catalogRowsToUpdate.values()].slice(0, 20),
    chapterIdentityConflicts,
    chapterIdentityConflictExamples,
    retainedHistory,
    addedHistory: backup.history.length - retainedHistory,
  };
}

/** All account-visible replacement writes share one SQLite transaction. Catalog rows are
 * retained because another account, a download, or a source-only read may reference them. */
export async function replaceBackup(
  backup: ReplaceBackupBody,
  userId?: string,
  jobId?: string,
  onProgress?: (completed: number, total: number, phase: string) => void,
) {
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

      const chapterIds = [
        ...new Set([
          ...backup.manga.flatMap((entry) => entry.chapters.map((chapter) => chapter.id)),
          ...backup.history.flatMap((row) => (row.chapter_id ? [row.chapter_id] : [])),
        ]),
      ];
      const existingChapterById = new Map<string, ExistingRestoreChapter>();
      for (const group of chunks(chapterIds, LOOKUP_CHUNK_SIZE)) {
        const rows = await tx.chapter.findMany({
          where: { id: { in: group } },
          select: {
            id: true,
            manga_id: true,
            last_page_read: true,
            is_read: true,
            manga: { select: { source: true, slug: true } },
          },
        });
        for (const row of rows) existingChapterById.set(row.id, row);
      }
      const chapterCreateRows: Prisma.chapterCreateManyInput[] = [];
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
          const existing = existingChapterById.get(chapter.id);
          if (existing?.manga_id && existing.manga_id !== manga.id) {
            throw new Error('Chapter identity conflicts with another title');
          }
          const restoredState = !userId
            ? {
                is_read: chapter.is_read,
                is_bookmark: chapter.is_bookmark,
                last_page_read: chapter.last_page_read,
              }
            : {};
          if (existing) {
            await tx.chapter.update({
              where: { id: chapter.id },
              data: { manga_id: manga.id, ...catalog, ...restoredState },
            });
          } else {
            chapterCreateRows.push({
              id: chapter.id,
              manga_id: manga.id,
              ...catalog,
              ...restoredState,
            });
          }
          existingChapterById.set(chapter.id, {
            id: chapter.id,
            manga_id: manga.id,
            last_page_read: userId ? (existing?.last_page_read ?? 0) : chapter.last_page_read,
            is_read: userId ? (existing?.is_read ?? false) : chapter.is_read,
            manga: { source: entry.source, slug: entry.slug },
          });
          if (userId && (chapter.is_read || chapter.is_bookmark || chapter.last_page_read > 0)) {
            userChapterStateRows.push({
              user_id: userId,
              chapter_id: chapter.id,
              is_read: chapter.is_read,
              is_bookmark: chapter.is_bookmark,
              last_page_read: chapter.last_page_read,
            });
          }
          if (chapter.last_page_read > 0) savedPositionIds.add(chapter.id);
          restoredChapterCount += 1;
        }
        reportProgress('Restoring titles');
      }
      for (const group of chunks(chapterCreateRows, INSERT_CHUNK_SIZE)) {
        await tx.chapter.createMany({ data: group });
      }
      for (const group of chunks(userChapterStateRows, INSERT_CHUNK_SIZE)) {
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
      if (userId) {
        for (const group of chunks(userMangaStateRows, INSERT_CHUNK_SIZE)) {
          await tx.user_manga_state.createMany({ data: group });
        }
      } else {
        for (const group of chunks(mangaLibraryRows, INSERT_CHUNK_SIZE)) {
          await tx.manga_library.createMany({ data: group });
        }
      }
      for (let index = 0; index < userMangaStateRows.length + mangaLibraryRows.length; index++) {
        reportProgress('Restoring library state');
      }
      const existingHistory = replacing
        ? new Set<string>()
        : new Set(
            (
              await tx.history.findMany({
                where: { user_id: userId ?? null, deleted_at: null },
                select: { source: true, manga_slug: true, chapter_id: true },
              })
            ).map((row) => `${row.source}\0${row.manga_slug}\0${row.chapter_id ?? ''}`),
          );
      let restoredHistory = 0;
      const historyCreateRows: Prisma.historyCreateManyInput[] = [];
      for (const row of backup.history) {
        const historyKey = `${row.source}\0${row.manga_slug}\0${row.chapter_id ?? ''}`;
        if (existingHistory.has(historyKey)) {
          reportProgress('Restoring reading history');
          continue;
        }
        existingHistory.add(historyKey);
        restoredHistory += 1;
        const mangaId = row.manga_id ? (idMap.get(row.manga_id) ?? null) : null;
        const chapterId = row.chapter_id ?? null;
        if (chapterId) {
          if (row.last_page_read > 0) savedPositionIds.add(chapterId);
          let chapter = existingChapterById.get(chapterId) ?? null;
          if (
            chapter?.manga &&
            (chapter.manga.source !== row.source || chapter.manga.slug !== row.manga_slug)
          ) {
            throw new Error('History chapter identity conflicts with another title');
          }
          if (!chapter) {
            await tx.chapter.create({
              data: {
                id: chapterId,
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
              manga: mangaId ? { source: row.source, slug: row.manga_slug } : null,
            };
            existingChapterById.set(chapterId, chapter);
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
              if (chapter) {
                existingChapterById.set(chapterId, {
                  ...chapter,
                  last_page_read: lastPageRead,
                  is_read: isRead,
                });
              }
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
      if (jobId) {
        await tx.restore_job.update({
          where: { id: jobId },
          data: { state: 'succeeded', result: JSON.stringify(result), payload: '' },
        });
      }
      return result;
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
}
