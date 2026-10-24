import libraryRepository from '../repositories/library.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import userLibraryRepository from '../repositories/userLibrary.repository.js';
import userMangaStateRepository from '../repositories/userMangaState.repository.js';
import trackerService from './tracker.service.js';
import { MangaNotFoundError } from '../utils/customErrors.js';
import type { UpdateLibraryStateBody } from '@projekt-manga/schemas';

const getLibraryState = async (user_id?: string) => {
  if (user_id) {
    return await userMangaStateRepository.getForUser(user_id);
  }
  return await libraryRepository.getAll();
};

const updateLibraryState = async (
  manga_id: string,
  patch: UpdateLibraryStateBody,
  user_id?: string,
) => {
  const manga = await mangaRepository.getMangaById(manga_id);
  if (!manga) {
    throw new MangaNotFoundError();
  }
  if (user_id) {
    const result = await userMangaStateRepository.upsert(user_id, manga.id, patch);
    if (patch.shelf_status !== undefined) {
      trackerService
        .pushStatusIfLinked(user_id, manga.id, patch.shelf_status)
        .catch((error) =>
          console.error(`[tracker] Status push failed for manga ${manga.id}:`, error),
        );
    }
    if (patch.score !== undefined) {
      trackerService
        .pushScoreIfLinked(user_id, manga.id, patch.score)
        .catch((error) =>
          console.error(`[tracker] Score push failed for manga ${manga.id}:`, error),
        );
    }
    return result;
  }
  // score is account-only (there's no anonymous personal-rating table, and tracker
  // linking itself requires an account) — stripped here rather than validated away,
  // since the same request body schema is shared by both the logged-in and anonymous
  // branches of this one endpoint.
  const { score: _score, ...anonymousPatch } = patch;
  return await libraryRepository.upsert(manga.id, anonymousPatch);
};

/** Called whenever new chapters land for a manga so a previously-seen "new chapter"
 * notification becomes unread again. Shared trigger (source polling isn't scoped to any
 * one account), so it resets the notification for every account that has this manga in
 * their library too, not just the anonymous shared state. */
const resetNotification = async (manga_id: string) => {
  await libraryRepository.upsert(manga_id, { notification_read: false });

  const followerIds = await userLibraryRepository.getUserIdsForManga(manga_id);
  for (const user_id of followerIds) {
    await userMangaStateRepository.upsert(user_id, manga_id, { notification_read: false });
  }
};

const libraryService = {
  getLibraryState,
  updateLibraryState,
  resetNotification,
};

export default libraryService;
