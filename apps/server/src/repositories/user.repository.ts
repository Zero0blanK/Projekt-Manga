import prisma from '../configs/prisma.config.js';
import { Prisma } from '@prisma/client';

const getByEmail = async (email: string) => {
  return await prisma.user.findUnique({ where: { email } });
};

const getById = async (id: string) => {
  return await prisma.user.findUnique({ where: { id } });
};

const create = async (data: { email: string; password_hash: string; display_name?: string }) => {
  return await prisma.user.create({ data });
};

const deleteById = async (id: string) => {
  return await prisma.$transaction(async (tx) => {
    // Jobs are deliberately not foreign-keyed to accounts because anonymous restores
    // share this table. Remove an account's queued payload before deleting its user row.
    await tx.restore_job.deleteMany({ where: { owner: id } });
    return tx.user.delete({ where: { id } });
  });
};

/** Creates the account and decides "is this the very first account this server has
 * ever had" in one transaction, so two near-simultaneous registrations (e.g. a
 * double-submitted form) can't both observe count()===0 and both go on to claim the
 * existing anonymous data as their own.
 *
 * Under SQLite the protection comes from the engine rather than from conflict detection:
 * only one write transaction runs at a time, so the second registration cannot read the
 * count until the first has committed its user row. The explicit Serializable level is
 * kept because it states the requirement and stays correct on another datasource. */
const createAndCheckFirstAccount = async (data: {
  email: string;
  password_hash: string;
  display_name?: string;
}) => {
  return await prisma.$transaction(
    async (tx) => {
      const existingCount = await tx.user.count();
      const user = await tx.user.create({ data });
      return { user, isFirstAccount: existingCount === 0 };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

const userRepository = {
  getByEmail,
  getById,
  create,
  deleteById,
  createAndCheckFirstAccount,
};

export default userRepository;
