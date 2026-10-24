import prisma from '../configs/prisma.config.js';
import type { TrackerService } from '@projekt-manga/types';
const getForUserAndManga = async (user_id: string, manga_id: string) => {
  return await prisma.tracker_link.findMany({ where: { user_id, manga_id } });
};

const getEnabledForUserAndManga = async (user_id: string, manga_id: string) => {
  return await prisma.tracker_link.findMany({ where: { user_id, manga_id, sync_enabled: true } });
};

const upsert = async (
  user_id: string,
  manga_id: string,
  tracker: TrackerService,
  data: { tracker_media_id: string; sync_enabled: boolean; last_synced_at: Date | null },
) => {
  return await prisma.tracker_link.upsert({
    where: { user_id_manga_id_tracker: { user_id, manga_id, tracker } },
    create: { user_id, manga_id, tracker, ...data },
    update: data,
  });
};

const touchSyncedAt = async (id: string) => {
  return await prisma.tracker_link.update({ where: { id }, data: { last_synced_at: new Date() } });
};

const deleteLink = async (user_id: string, manga_id: string, tracker: TrackerService) => {
  return await prisma.tracker_link.deleteMany({ where: { user_id, manga_id, tracker } });
};

/** Used when a tracker account is disconnected — its links have nothing left to sync
 * through and would otherwise dangle indefinitely. */
const deleteAllForUserAndTracker = async (user_id: string, tracker: TrackerService) => {
  return await prisma.tracker_link.deleteMany({ where: { user_id, tracker } });
};

/** Every enabled link across every account — the polling job's own entry point. */
const getAllEnabled = async () => {
  return await prisma.tracker_link.findMany({ where: { sync_enabled: true } });
};

/** One account's enabled links — what a manual "Sync now" operates over. */
const getEnabledForUser = async (user_id: string) => {
  return await prisma.tracker_link.findMany({ where: { user_id, sync_enabled: true } });
};

const trackerLinkRepository = {
  getForUserAndManga,
  getEnabledForUserAndManga,
  upsert,
  touchSyncedAt,
  deleteLink,
  deleteAllForUserAndTracker,
  getAllEnabled,
  getEnabledForUser,
};

export default trackerLinkRepository;
