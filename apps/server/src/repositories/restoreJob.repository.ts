import prisma from '../configs/prisma.config.js';
import { DuplicateResourceError, NotFoundError } from '../utils/customErrors.js';

const ACTIVE_STATES = ['queued', 'running'];

/** Takes a queued job for the worker. False when something else got there first. */
const claim = async (id: string): Promise<boolean> => {
  const claimed = await prisma.restore_job.updateMany({
    where: { id, state: 'queued' },
    data: { state: 'running' },
  });
  return claimed.count === 1;
};

const getById = async (id: string) => prisma.restore_job.findUnique({ where: { id } });

const getByIdOrThrow = async (id: string) =>
  prisma.restore_job.findUniqueOrThrow({ where: { id } });

const markFailed = async (id: string) => {
  await prisma.restore_job.updateMany({
    where: { id, state: 'running' },
    data: { state: 'failed', payload: '' },
  });
};

/** Returns the job already holding this id if it's the same request, so a retried upload
 * doesn't queue twice. One restore at a time per library. */
const createOrGetExisting = async (data: {
  id: string;
  owner: string;
  request_id: string | null;
  payload: string;
}) =>
  prisma.$transaction(async (tx) => {
    const existing = await tx.restore_job.findUnique({ where: { id: data.id } });
    if (existing) {
      if (existing.owner !== data.owner || (existing.payload && existing.payload !== data.payload))
        throw new NotFoundError('Restore job not found');
      return existing;
    }
    const active = await tx.restore_job.findFirst({
      where: { owner: data.owner, state: { in: ACTIVE_STATES } },
      select: { id: true },
    });
    if (active) throw new DuplicateResourceError('A restore is already running for this library');
    return tx.restore_job.create({ data: { ...data, state: 'queued' } });
  });

const cancelQueued = async (id: string, owner: string) => {
  await prisma.restore_job.updateMany({
    where: { id, owner, state: 'queued' },
    data: { state: 'cancelled', payload: '' },
  });
};

/** Puts jobs a crash left running back in the queue, and lists the queue. */
const requeueInterrupted = async () => {
  await prisma.restore_job.updateMany({ where: { state: 'running' }, data: { state: 'queued' } });
  return prisma.restore_job.findMany({
    where: { state: 'queued' },
    select: { id: true, request_id: true },
    orderBy: { created_at: 'asc' },
  });
};

/** Finished jobs only exist so a client can read the outcome; a month is plenty. */
const pruneFinished = async (olderThan: Date) => {
  await prisma.restore_job.deleteMany({
    where: { state: { notIn: ACTIVE_STATES }, created_at: { lt: olderThan } },
  });
};

const hasActive = async (owner: string): Promise<boolean> => {
  const active = await prisma.restore_job.findFirst({
    where: { owner, state: { in: ACTIVE_STATES } },
    select: { id: true },
  });
  return active !== null;
};

const restoreJobRepository = {
  claim,
  getById,
  getByIdOrThrow,
  markFailed,
  createOrGetExisting,
  cancelQueued,
  requeueInterrupted,
  pruneFinished,
  hasActive,
};

export default restoreJobRepository;
