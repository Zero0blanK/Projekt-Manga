import prisma from '../configs/prisma.config.js';
import { DuplicateResourceError, NotFoundError } from '../utils/customErrors.js';

const ACTIVE_STATES = ['queued', 'running'];

/**
 * How many times a job may be started. A job found running at startup was interrupted:
 * resumed once in case the crash was unrelated, then failed, in case the restore itself is
 * what brings the server down. Failing is safe: the restore is one transaction, so an
 * interrupted attempt left the library as it was.
 */
export const MAX_RESTORE_ATTEMPTS = 2;

/** Takes a queued job for the worker. False when something else got there first. */
const claim = async (id: string): Promise<boolean> => {
  const claimed = await prisma.restore_job.updateMany({
    where: { id, state: 'queued' },
    data: { state: 'running', attempts: { increment: 1 } },
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

/**
 * Settles jobs a crash left running, then lists the queue. Those with attempts to spare go
 * back in the queue; the rest are failed and returned as `abandoned`.
 */
const requeueInterrupted = async () =>
  prisma.$transaction(async (tx) => {
    const abandoned = await tx.restore_job.findMany({
      where: { state: 'running', attempts: { gte: MAX_RESTORE_ATTEMPTS } },
      select: { id: true, request_id: true },
    });
    if (abandoned.length) {
      await tx.restore_job.updateMany({
        where: { id: { in: abandoned.map((job) => job.id) } },
        data: { state: 'failed', payload: '' },
      });
    }
    await tx.restore_job.updateMany({ where: { state: 'running' }, data: { state: 'queued' } });
    const queued = await tx.restore_job.findMany({
      where: { state: 'queued' },
      select: { id: true, request_id: true },
      orderBy: { created_at: 'asc' },
    });
    return { queued, abandoned };
  });

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
