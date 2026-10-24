import prisma from '../configs/prisma.config.js';
import { Prisma } from '@prisma/client';
import { isMangaStatus, type MangaStatus } from '@projekt-manga/types';
import type { GetMangaOptions, AddMangaPayload } from '@projekt-manga/types';
import { DuplicateResourceError } from '../utils/customErrors.js';

/** Extensions report status as a plain string; this is the one place that maps it onto
 * the stored vocabulary, falling back to UNKNOWN for anything unrecognized instead of
 * letting a bad value hit the database.
 *
 * Matched case-insensitively: sources aren't required to use the exact casing (MangaDex
 * reports lowercase "ongoing").
 *
 * The column is a plain String under SQLite, so there is no runtime enum object; the value
 * set lives in packages/types and is checked with `isMangaStatus`. */
const toMangaStatus = (status: string): MangaStatus => {
  const normalized = (status ?? '').trim().toUpperCase();
  return isMangaStatus(normalized) ? normalized : 'UNKNOWN';
};

const SORT_FIELD_MAP: Record<string, string> = {
  title: 'title',
  recentlyRead: 'last_read_at',
  dateAdded: 'created_at',
};
const USER_LIBRARY_QUERY_BATCH_SIZE = 200;

const resolveOrderBy = (options: GetMangaOptions): Record<string, 'asc' | 'desc'> => {
  const { sortBy = 'title', sortOrder = 'asc' } = options;
  const field = SORT_FIELD_MAP[sortBy] || 'title';
  return { [field]: sortOrder };
};

type MangaWithChapterCount = {
  id: string;
  _count: { chapter: number };
  chapter: { release_date: Date | null }[];
};

/** Attaches chapter_count/latest_chapter_date/unread_count to a manga listing query result. */
const withListingCounts = async <T extends MangaWithChapterCount>(mangaList: T[]) => {
  const mangaIds = mangaList.map((m) => m.id);
  const unreadAgg =
    mangaIds.length > 0
      ? await prisma.chapter.groupBy({
          by: ['manga_id'],
          where: { manga_id: { in: mangaIds }, is_read: false },
          _count: { id: true },
        })
      : [];

  const unreadMap = new Map(unreadAgg.map((row) => [row.manga_id, row._count.id]));

  return mangaList.map((mangaItem) => ({
    ...mangaItem,
    chapter_count: mangaItem._count.chapter,
    latest_chapter_date: mangaItem.chapter.length > 0 ? mangaItem.chapter[0].release_date : null,
    unread_count: unreadMap.get(mangaItem.id) ?? 0,
  }));
};

const getManga = async (options: GetMangaOptions) => {
  const manga = await prisma.manga.findMany({
    // Rows created purely to back a preview read or download aren't library entries.
    where: { in_library: true },
    orderBy: resolveOrderBy(options),
    include: {
      _count: {
        select: { chapter: true },
      },
      chapter: {
        take: 1,
        select: { release_date: true },
        orderBy: { release_date: 'desc' },
      },
      manga_detail: {
        // artist and rating are included: the library listing feeds the detail header for
        // a title reached from Discover.
        select: { status: true, genres: true, description: true, artist: true, rating: true },
      },
      cache: { select: { sha256_url: true } },
    },
  });

  return withListingCounts(manga);
};

/** Per-account equivalent of getManga: membership comes from user_library instead of
 * manga.in_library, and unread_count is computed from user_chapter_state instead of the
 * shared chapter.is_read column. Returns the same shape as withListingCounts. */
const getMangaForUser = async (user_id: string, options: GetMangaOptions) => {
  const membershipFilter = { some: { user_id, deleted_at: null } };
  const orderBy = [resolveOrderBy(options), { id: 'asc' as const }];
  const [mangaPages, readCounts] = await Promise.all([
    (async () => {
      const pages = [];
      for (let skip = 0; ; skip += USER_LIBRARY_QUERY_BATCH_SIZE) {
        const page = await prisma.manga.findMany({
          where: { user_library: membershipFilter },
          orderBy,
          skip,
          take: USER_LIBRARY_QUERY_BATCH_SIZE,
          include: {
            _count: { select: { chapter: true } },
            chapter: {
              take: 1,
              select: { release_date: true },
              orderBy: { release_date: 'desc' },
            },
            manga_detail: {
              select: {
                status: true,
                genres: true,
                description: true,
                artist: true,
                rating: true,
              },
            },
            cache: { select: { sha256_url: true } },
          },
        });
        pages.push(...page);
        if (page.length < USER_LIBRARY_QUERY_BATCH_SIZE) return pages;
      }
    })(),
    prisma.$queryRaw<Array<{ manga_id: string; read_count: number | bigint }>>(Prisma.sql`
      SELECT c.manga_id, COUNT(s.chapter_id) AS read_count
      FROM chapters AS c
      INNER JOIN user_library AS ul
        ON ul.manga_id = c.manga_id
        AND ul.user_id = ${user_id}
        AND ul.deleted_at IS NULL
      INNER JOIN user_chapter_state AS s
        ON s.chapter_id = c.id
        AND s.user_id = ${user_id}
        AND s.is_read = 1
      GROUP BY c.manga_id
    `),
  ]);

  const readCountByManga = new Map(readCounts.map((row) => [row.manga_id, Number(row.read_count)]));

  return mangaPages.map((mangaItem) => ({
    ...mangaItem,
    in_library: true,
    chapter_count: mangaItem._count.chapter,
    latest_chapter_date: mangaItem.chapter.length > 0 ? mangaItem.chapter[0].release_date : null,
    unread_count: Math.max(0, mangaItem._count.chapter - (readCountByManga.get(mangaItem.id) ?? 0)),
  }));
};

/** Per-account equivalent of getMangaByCategoryId: resolves manga ids via the private
 * user_manga_category join instead of the shared manga_category table. */
const getMangaByCategoryIdForUser = async (
  user_id: string,
  category_id: string,
  options: GetMangaOptions,
) => {
  const assignments = await prisma.user_manga_category.findMany({
    where: { user_id, category_id, deleted_at: null },
    select: { manga_id: true },
  });
  const mangaIds = assignments.map((a) => a.manga_id);
  if (mangaIds.length === 0) {
    return [];
  }

  const manga = await prisma.manga.findMany({
    where: { id: { in: mangaIds } },
    orderBy: resolveOrderBy(options),
    include: {
      _count: { select: { chapter: true } },
      chapter: {
        take: 1,
        select: { release_date: true },
        orderBy: { release_date: 'desc' },
      },
      cache: { select: { sha256_url: true } },
    },
  });

  return withListingCounts(manga);
};

/** Per-account equivalent of getMangaDetailsById: overlays is_read/is_bookmark/
 * last_page_read from user_chapter_state onto the shared chapter catalog, defaulting a
 * chapter this account has never touched to unread/page 0. */
const getMangaDetailsByIdForUser = async (user_id: string, manga_id: string) => {
  const manga = await prisma.manga.findUnique({
    where: { id: manga_id },
    include: { manga_detail: true, chapter: true, cache: { select: { sha256_url: true } } },
  });
  if (!manga) {
    return null;
  }

  const membership = await prisma.user_library.findUnique({
    where: { user_id_manga_id: { user_id, manga_id } },
    select: { deleted_at: true },
  });

  const chapterIds = manga.chapter.map((c) => c.id);
  const states =
    chapterIds.length > 0
      ? await prisma.user_chapter_state.findMany({
          where: { user_id, chapter_id: { in: chapterIds } },
        })
      : [];
  const stateByChapter = new Map(states.map((s) => [s.chapter_id, s]));

  return {
    ...manga,
    in_library: membership !== null && membership.deleted_at === null,
    chapter: manga.chapter.map((c) => {
      const state = stateByChapter.get(c.id);
      return {
        ...c,
        is_read: state?.is_read ?? false,
        is_bookmark: state?.is_bookmark ?? false,
        last_page_read: state?.last_page_read ?? 0,
      };
    }),
  };
};

const getMangaDetailsById = async (manga_id: string) => {
  return await prisma.manga.findUnique({
    where: {
      id: manga_id,
    },
    include: {
      manga_detail: true,
      chapter: true,
      cache: { select: { sha256_url: true } },
    },
  });
};

/** When this title's stored details were last written, or null without a details row. */
const getDetailsUpdatedAt = async (manga_id: string) => {
  const row = await prisma.manga_detail.findUnique({
    where: { manga_id },
    select: { updated_at: true, description: true, manga: { select: { author: true } } },
  });
  return row
    ? {
        updatedAt: row.updated_at,
        incomplete: !row.description.trim() || row.manga.author === 'Unknown',
      }
    : null;
};

/** Rewrites a library title's descriptive fields from a fresh source read. Title, slug and
 * reading state are left alone: only what the source describes is replaced. */
const refreshDetails = async (
  manga_id: string,
  details: {
    author: string;
    artist: string;
    description: string;
    genres: string;
    status: string;
    thumbnail_url?: string;
  },
) => {
  await prisma.$transaction([
    prisma.manga.update({
      where: { id: manga_id },
      data: {
        author: details.author,
        ...(details.thumbnail_url ? { thumbnail_url: details.thumbnail_url } : {}),
      },
    }),
    prisma.manga_detail.upsert({
      where: { manga_id },
      update: {
        artist: details.artist,
        description: details.description,
        genres: details.genres,
        status: toMangaStatus(details.status),
      },
      create: {
        manga_id,
        artist: details.artist,
        description: details.description,
        genres: details.genres,
        status: toMangaStatus(details.status),
      },
    }),
  ]);
};

const getMangaById = async (manga_id: string) => {
  const byId = await prisma.manga.findFirst({ where: { id: manga_id } });
  if (byId) return byId;
  const matches = await prisma.manga.findMany({ where: { slug: manga_id }, take: 2 });
  if (matches.length > 1) throw new DuplicateResourceError('Manga slug needs a source');
  return matches[0] ?? null;
};

const getMangaIdBySlug = async (manga_slug: string, source?: string) => {
  if (source) {
    return await prisma.manga.findFirst({
      where: { source, slug: manga_slug },
      select: { id: true },
    });
  }
  const first = await prisma.manga.findFirst({
    where: { slug: manga_slug },
    select: { id: true },
  });
  if (!first) return null;
  const second = await prisma.manga.findFirst({
    where: { slug: manga_slug, id: { not: first.id } },
    select: { id: true },
  });
  if (second) throw new DuplicateResourceError('Manga slug needs a source');
  return first;
};

const getMangaBySlug = async (manga_slug: string, source: string) => {
  return await prisma.manga.findFirst({
    where: { source, slug: manga_slug },
  });
};

const getMangaByCategory = async (category_id: string) => {
  return await prisma.manga_category.findMany({
    where: {
      category_id: category_id,
    },
    include: {
      manga: true,
    },
  });
};

const searchMangaByQuery = async (query: string) => {
  return await prisma.manga.findMany({
    where: {
      OR: [{ title: { contains: query } }, { author: { contains: query } }],
    },
    include: {
      manga_detail: {
        // artist and rating are included: the library listing feeds the detail header for
        // a title reached from Discover.
        select: { status: true, genres: true, description: true, artist: true, rating: true },
      },
    },
  });
};

const addManga = async (manga_data: AddMangaPayload, user_id?: string) => {
  return await prisma.$transaction(async (prisma) => {
    /**
     * Scoped to the source on purpose — "already have this" only means anything within one
     * source.
     *
     * Two sources carrying the same series are a **cross-source duplicate**, which is a
     * decision for the reader, not this function: the Discover flow detects them
     * client-side and offers "show entry", "add to library anyway" and "migrate"
     * (lib/duplicate-detection.ts, discover/duplicate-manga-dialog.tsx). Matching across
     * sources here would answer 409 to "add to library anyway".
     *
     * Slugs are source-native IDs; the database and this lookup both scope them to a
     * source so two sources can use the same numeric or short string ID independently.
     */
    const existingManga = await prisma.manga.findFirst({
      where: {
        source: manga_data.source,
        OR: [{ title: manga_data.title }, { slug: manga_data.slug }],
      },
    });

    const wantsLibrary = manga_data.in_library !== false;

    const attachChapters = async (mangaId: string) => {
      if (!manga_data.chapters?.length) return;

      const chapters = manga_data.chapters.map((chapter) => {
        const parsedReleaseDate = chapter.release_date ? new Date(chapter.release_date) : null;
        return {
          id: chapter.id,
          manga_id: mangaId,
          url: chapter.url || '',
          name: chapter.name || '',
          scanlator: chapter.scanlator || '',
          chapter_number: chapter.chapter_number,
          last_page_read: chapter.last_page_read || 0,
          release_date:
            parsedReleaseDate && !Number.isNaN(parsedReleaseDate.getTime())
              ? parsedReleaseDate
              : null,
          page_count: chapter.page_count || 0,
        };
      });
      const existingChapters = await prisma.chapter.findMany({
        where: { id: { in: chapters.map((chapter) => chapter.id) } },
        select: {
          id: true,
          url: true,
          name: true,
          scanlator: true,
          chapter_number: true,
          page_count: true,
          release_date: true,
        },
      });
      const existingChapterIds = existingChapters.map((chapter) => chapter.id);

      if (existingChapterIds.length > 0) {
        await prisma.chapter.updateMany({
          where: { id: { in: existingChapterIds } },
          data: { manga_id: mangaId },
        });
        const existingById = new Map(existingChapters.map((chapter) => [chapter.id, chapter]));
        for (const chapter of chapters) {
          const existing = existingById.get(chapter.id);
          if (!existing) continue;
          const data = {
            ...(existing.chapter_number === 0 && chapter.chapter_number > 0
              ? { chapter_number: chapter.chapter_number }
              : {}),
            ...(!existing.url && chapter.url ? { url: chapter.url } : {}),
            ...(!existing.name && chapter.name ? { name: chapter.name } : {}),
            ...(!existing.scanlator && chapter.scanlator ? { scanlator: chapter.scanlator } : {}),
            ...(!existing.release_date && chapter.release_date
              ? { release_date: chapter.release_date }
              : {}),
            ...((existing.page_count ?? 0) <= 0 && chapter.page_count > 0
              ? { page_count: chapter.page_count }
              : {}),
          };
          if (Object.keys(data).length === 0) continue;
          await prisma.chapter.update({
            where: { id: chapter.id },
            data,
          });
        }
        await prisma.history.updateMany({
          where: {
            source: manga_data.source,
            manga_slug: manga_data.slug,
            chapter_id: { in: existingChapterIds },
          },
          data: { manga_id: mangaId, sync_updated_at: new Date() },
        });
      }

      const existingIds = new Set(existingChapterIds);
      const newChapters = chapters.filter((chapter) => !existingIds.has(chapter.id));
      if (newChapters.length > 0) {
        await prisma.chapter.createMany({ data: newChapters });
      }
    };

    if (existingManga) {
      // in_library:false means "make sure a row exists" (reading/downloading from a
      // source), not "add" — so it's idempotent and never demotes a title the user has
      // actually added.
      if (!wantsLibrary) {
        await attachChapters(existingManga.id);
        return existingManga;
      }
      // The shared flag does not describe any one account's library membership.
      if (user_id) {
        const membership = await prisma.user_library.findUnique({
          where: { user_id_manga_id: { user_id, manga_id: existingManga.id } },
          select: { deleted_at: true },
        });
        if (membership && !membership.deleted_at) {
          throw new DuplicateResourceError('Manga already exists in library');
        }
        await attachChapters(existingManga.id);
        return existingManga;
      }
      // A row may already exist only because the title was previewed/downloaded from a
      // source. Adding it to the library then isn't a duplicate — it's adopting that
      // shadow row, so flip the flag and hand it back instead of failing.
      if (!existingManga.in_library) {
        const promoted = await prisma.manga.update({
          where: { id: existingManga.id },
          data: { in_library: true },
        });
        await attachChapters(promoted.id);
        return promoted;
      }
      throw new DuplicateResourceError('Manga already exists in library');
    }

    const manga = await prisma.manga.create({
      data: {
        slug: manga_data.slug,
        title: manga_data.title,
        author: manga_data.author ?? 'Unknown',
        source: manga_data.source,
        thumbnail_url: manga_data.thumbnail_url,
        in_library: !user_id && wantsLibrary,
      },
    });

    await prisma.manga_detail.create({
      data: {
        manga_id: manga.id,
        artist: manga_data.artist ?? 'Unknown',
        description: manga_data.description,
        genres: manga_data.genres,
        status: toMangaStatus(manga_data.status),
        rating: manga_data.rating || null,
      },
    });

    await attachChapters(manga.id);

    return manga;
  });
};

const deleteManga = async (manga_id: string) => {
  return await prisma.$transaction(async (prisma) => {
    const manga = await prisma.manga.findFirst({
      where: {
        OR: [{ id: manga_id }, { slug: manga_id }],
      },
      select: {
        id: true,
      },
    });

    // Without this guard, an unmatched manga_id would leave every `manga_id: manga?.id`
    // filter below as `manga_id: undefined` — which Prisma treats as "no filter" and
    // would delete/detach every manga's chapters, history, categories, and details.
    if (!manga) {
      return { count: 0 };
    }

    const hasHistory = await prisma.history.findFirst({
      where: {
        manga_id: manga.id,
      },
    });

    await prisma.manga_category.deleteMany({
      where: {
        manga_id: manga.id,
      },
    });

    if (hasHistory) {
      await prisma.chapter.updateMany({
        where: {
          manga_id: manga.id,
        },
        data: {
          manga_id: null,
        },
      });

      await prisma.history.updateMany({
        where: {
          manga_id: manga.id,
        },
        data: {
          manga_id: null,
          sync_updated_at: new Date(),
        },
      });
    } else {
      await prisma.chapter.deleteMany({
        where: {
          manga_id: manga.id,
        },
      });
    }

    await prisma.manga_detail.deleteMany({
      where: {
        manga_id: manga.id,
      },
    });

    const deletedManga = await prisma.manga.deleteMany({
      where: {
        id: manga.id,
      },
    });

    return deletedManga;
  });
};

/** Adds or removes a manga from the library without touching the row itself — its
 * chapters, downloads and read progress all survive being removed. */
const setInLibrary = async (manga_id: string, in_library: boolean) => {
  return await prisma.manga.update({
    where: { id: manga_id },
    data: { in_library },
  });
};

const addMangaToCategory = async (manga_id: string, category_id: string) => {
  return await prisma.manga_category.create({
    data: {
      manga_id: manga_id,
      category_id: category_id,
    },
  });
};

const getMangaByCategoryId = async (category_id: string, options: GetMangaOptions) => {
  const mangaCategories = await prisma.manga_category.findMany({
    where: {
      category_id: category_id,
    },
    select: {
      manga_id: true,
    },
  });

  const mangaIds = mangaCategories.map((mc: { manga_id: string }) => mc.manga_id);

  const manga = await prisma.manga.findMany({
    where: { id: { in: mangaIds } },
    orderBy: resolveOrderBy(options),
    include: {
      _count: { select: { chapter: true } },
      chapter: {
        take: 1,
        select: { release_date: true },
        orderBy: { release_date: 'desc' },
      },
      cache: { select: { sha256_url: true } },
    },
  });

  return withListingCounts(manga);
};

/** Used only by auth.service's "first account claims existing anonymous data" — every
 * manga currently in the shared anonymous library. */
const listLibraryMangaIds = async () => {
  const rows = await prisma.manga.findMany({ where: { in_library: true }, select: { id: true } });
  return rows.map((r) => r.id);
};

/**
 * Every manga anyone actually has in a library, for the update sweep.
 *
 * Deliberately not every `manga` row: a row can exist with `in_library = false` — a
 * shadow row created when a download or a bookmark needed a manga_id. Sweeping those
 * would scrape sources for titles nobody added.
 *
 * Membership lives in two places — the shared `in_library`
 * flag for anonymous use, and a `user_library` row per account — so this unions both
 * rather than picking one and silently missing the other's titles.
 */
const listLibraryBasic = async () => {
  return await prisma.manga.findMany({
    where: {
      OR: [{ in_library: true }, { user_library: { some: { deleted_at: null } } }],
    },
    select: { id: true, slug: true, title: true, source: true },
  });
};

const mangaRepository = {
  getDetailsUpdatedAt,
  refreshDetails,
  getManga,
  getMangaForUser,
  listLibraryMangaIds,
  getMangaById,
  getMangaIdBySlug,
  getMangaBySlug,
  listLibraryBasic,
  getMangaDetailsById,
  getMangaDetailsByIdForUser,
  getMangaByCategory,
  searchMangaByQuery,
  addManga,
  deleteManga,
  setInLibrary,
  addMangaToCategory,
  getMangaByCategoryId,
  getMangaByCategoryIdForUser,
};

export default mangaRepository;
