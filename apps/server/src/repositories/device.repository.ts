import prisma from '../configs/prisma.config.js';
import type { DevicePlatform } from '@projekt-manga/types';
const create = async (data: { user_id: string; label: string; platform: DevicePlatform }) => {
  return await prisma.device.create({ data });
};

const getById = async (id: string) => {
  return await prisma.device.findUnique({ where: { id } });
};

const touchLastSeen = async (id: string) => {
  return await prisma.device.update({ where: { id }, data: { last_seen_at: new Date() } });
};

const deviceRepository = {
  create,
  getById,
  touchLastSeen,
};

export default deviceRepository;
