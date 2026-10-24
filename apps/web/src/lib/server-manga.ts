import { cookies } from 'next/headers';
import { getMangaDetailsById, ApiError } from '@projekt-manga/api-client';
import { SESSION_COOKIE_NAME } from '@projekt-manga/types';
import { fromMangaDetails, type Manga } from './manga-data';

/** Node fetch does not inherit the browser's session cookie during server rendering. */
export async function getRequestManga(id: string): Promise<Manga | null> {
  const sessionToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  try {
    return fromMangaDetails(await getMangaDetailsById(id, undefined, sessionToken));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
