import prisma from '../configs/prisma.config.js';

const create = async (data: {
  id: string;
  user_id: string;
  device_id?: string | null;
  user_agent?: string | null;
  expires_at: Date;
}) => {
  return await prisma.session.create({ data });
};

/** Includes the owning user — every caller that looks up a session needs it to attach
 * req.user, so this saves every call site its own follow-up query. */
const getByIdWithUser = async (id: string) => {
  return await prisma.session.findUnique({ where: { id }, include: { user: true } });
};

/** Records activity, and moves the expiry forward when `expires_at` is given. */
const touchLastSeen = async (id: string, expires_at?: Date) => {
  return await prisma.session.update({
    where: { id },
    data: { last_seen_at: new Date(), ...(expires_at ? { expires_at } : {}) },
  });
};

const deleteById = async (id: string) => {
  return await prisma.session.delete({ where: { id } }).catch(() => null);
};

/** "Sign out other devices" — every session for this account except the one making the
 * request. Returns the number of sessions revoked. */
const deleteAllExcept = async (user_id: string, keepSessionId: string) => {
  const result = await prisma.session.deleteMany({
    where: { user_id, id: { not: keepSessionId } },
  });
  return result.count;
};

/**
 * Drops every session already past its expiry. Returns how many were removed.
 *
 * Expiry is only *checked* on read (auth.service.ts's getSessionUser), so lapsed sessions
 * would otherwise accumulate. Nothing depends on an expired row, so this is pure cleanup.
 */
const deleteExpired = async () => {
  const result = await prisma.session.deleteMany({ where: { expires_at: { lte: new Date() } } });
  return result.count;
};

const sessionRepository = {
  create,
  getByIdWithUser,
  touchLastSeen,
  deleteById,
  deleteAllExcept,
  deleteExpired,
};

export default sessionRepository;
