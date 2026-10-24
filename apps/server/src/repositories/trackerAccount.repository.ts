import prisma from '../configs/prisma.config.js';
import type { TrackerService } from '@projekt-manga/types';
const getByUserAndTracker = async (user_id: string, tracker: TrackerService) => {
  return await prisma.tracker_account.findUnique({
    where: { user_id_tracker: { user_id, tracker } },
  });
};

const getAllForUser = async (user_id: string) => {
  return await prisma.tracker_account.findMany({ where: { user_id } });
};

const upsert = async (
  user_id: string,
  tracker: TrackerService,
  data: {
    access_token: string;
    refresh_token: string | null;
    expires_at: Date | null;
    tracker_user_id: string;
    tracker_username: string;
  },
) => {
  return await prisma.tracker_account.upsert({
    where: { user_id_tracker: { user_id, tracker } },
    create: { user_id, tracker, ...data },
    update: data,
  });
};

const deleteByUserAndTracker = async (user_id: string, tracker: TrackerService) => {
  return await prisma.tracker_account.deleteMany({ where: { user_id, tracker } });
};

const trackerAccountRepository = {
  getByUserAndTracker,
  getAllForUser,
  upsert,
  deleteByUserAndTracker,
};

export default trackerAccountRepository;
