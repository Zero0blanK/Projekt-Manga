import prisma from '../configs/prisma.config.js';

const list = async (user_id: string | null) =>
  prisma.notification_channel.findMany({ where: { user_id }, orderBy: { created_at: 'asc' } });

const listEnabled = async (user_id: string | null) =>
  prisma.notification_channel.findMany({ where: { user_id, enabled: true } });

const countFor = async (user_id: string | null) =>
  prisma.notification_channel.count({ where: { user_id } });

const create = async (data: {
  user_id: string | null;
  kind: string;
  name: string;
  target_encrypted: string;
}) => prisma.notification_channel.create({ data });

/** Scoped to the owner, so another identity's channel reads as missing. */
const findOwned = async (id: string, user_id: string | null) =>
  prisma.notification_channel.findFirst({ where: { id, user_id } });

const update = async (
  id: string,
  data: {
    name?: string;
    enabled?: boolean;
    last_sent_at?: Date;
    last_error?: string | null;
  },
) => prisma.notification_channel.update({ where: { id }, data });

const remove = async (id: string) => {
  await prisma.notification_channel.delete({ where: { id } });
};

const notificationChannelRepository = {
  list,
  listEnabled,
  countFor,
  create,
  findOwned,
  update,
  remove,
};

export default notificationChannelRepository;
