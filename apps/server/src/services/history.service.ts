import historyRepository from '../repositories/history.repository.js';
import { PrismaError, rethrowKnownOrWrap } from '../utils/customErrors.js';
import type { MangaHistory } from '@projekt-manga/types';

const getHistory = async (user_id?: string) => {
  try {
    const history = await historyRepository.getHistory(user_id);
    return history;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to retrieve manga history'));
  }
};

const addHistory = async (historyData: MangaHistory, user_id?: string) => {
  try {
    const newHistory = await historyRepository.addHistory(historyData, user_id);
    return newHistory;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to add manga history'));
  }
};

const getHistoryByMangaSlug = async (manga_slug: string, user_id?: string, source?: string) => {
  try {
    const history = await historyRepository.getHistoryByMangaSlug(manga_slug, user_id, source);
    return history;
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to retrieve manga history by slug'));
  }
};

const deleteHistory = async (id: string, user_id?: string) => {
  try {
    if (user_id) {
      return await historyRepository.softDeleteHistory(id, user_id);
    }
    return await historyRepository.deleteHistory(id);
  } catch (error) {
    rethrowKnownOrWrap(error, new PrismaError('Failed to delete history entry'));
  }
};

const historyService = {
  getHistory,
  addHistory,
  getHistoryByMangaSlug,
  deleteHistory,
};

export default historyService;
