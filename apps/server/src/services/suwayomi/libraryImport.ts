import { randomUUID } from 'node:crypto';
import { replaceBackupBodySchema } from '@projekt-manga/schemas';
import { absoluteSuwayomiUrl, requireConnection, suwayomiGraphql } from './client.js';
import { SUWAYOMI_PREFIX } from './source.js';

/**
 * Brings the Suwayomi server's library into this one: its titles, with their chapters' read
 * state. Goes through the restore job in merge mode, so nothing here is cleared, and a title
 * already in this library keeps its own state. Titles keep Suwayomi's ids, the same way a
 * title added from a Suwayomi source does.
 */

interface LibraryChapter {
  id: number;
  name: string | null;
  url: string | null;
  chapterNumber: number | null;
  scanlator: string | null;
  uploadDate: string | number | null;
  pageCount: number | null;
  isRead: boolean | null;
  isBookmarked: boolean | null;
  lastPageRead: number | null;
}

interface LibraryManga {
  id: number;
  sourceId: string;
  title: string;
  thumbnailUrl: string | null;
  author: string | null;
  artist: string | null;
  description: string | null;
  genre: string[] | null;
  status: string | null;
  chapters: { nodes: LibraryChapter[] } | null;
}

const LIBRARY_QUERY = `query {
  mangas(condition: { inLibrary: true }) {
    nodes {
      id sourceId title thumbnailUrl author artist description genre status
      chapters {
        nodes {
          id name url chapterNumber scanlator uploadDate pageCount isRead isBookmarked lastPageRead
        }
      }
    }
  }
}`;

function uploadDate(value: string | number | null): string | null {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : null;
}

/** A validated merge restore of `titles`, for the account (or anonymous library) `userId`. */
export function buildLibraryImport(titles: LibraryManga[], userId: string | null) {
  const connection = requireConnection();
  const usable = titles.filter((title) => title.title && /^-?\d+$/.test(String(title.sourceId)));
  return replaceBackupBodySchema.parse({
    jobId: randomUUID(),
    mode: 'merge',
    expectedUserId: userId,
    version: 2,
    manga: usable.map((title) => ({
      id: `${SUWAYOMI_PREFIX}${title.sourceId}:${title.id}`,
      source: `${SUWAYOMI_PREFIX}${title.sourceId}`,
      slug: String(title.id),
      title: title.title.slice(0, 255),
      author: title.author || 'Unknown',
      artist: title.artist,
      thumbnail_url: absoluteSuwayomiUrl(title.thumbnailUrl, connection) || 'none',
      description: title.description ?? '',
      genres: (title.genre ?? []).join(', '),
      status: title.status || 'UNKNOWN',
      rating: null,
      in_library: true,
      chapters: (title.chapters?.nodes ?? []).map((chapter) => ({
        id: String(chapter.id),
        source_chapter_key: String(chapter.id),
        url: chapter.url ?? '',
        name: chapter.name,
        scanlator: chapter.scanlator,
        chapter_number: chapter.chapterNumber ?? -1,
        last_page_read: Math.max(0, chapter.lastPageRead ?? 0),
        is_read: chapter.isRead === true,
        is_bookmark: chapter.isBookmarked === true,
        release_date: uploadDate(chapter.uploadDate),
        page_count: chapter.pageCount && chapter.pageCount > 0 ? chapter.pageCount : null,
      })),
    })),
    library: usable.map((title) => ({
      manga_id: `${SUWAYOMI_PREFIX}${title.sourceId}:${title.id}`,
      is_bookmarked: false,
      shelf_status: null,
      notification_read: true,
    })),
    history: [],
  });
}

export async function fetchSuwayomiLibrary(): Promise<LibraryManga[]> {
  const data = await suwayomiGraphql<{ mangas: { nodes: LibraryManga[] } }>(LIBRARY_QUERY);
  return data.mangas?.nodes ?? [];
}
