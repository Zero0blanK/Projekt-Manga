import type { PreviewBackupBody, ReplaceBackupBody } from '@projekt-manga/schemas';
import prisma from '../configs/prisma.config.js';
import { previewBackupConflicts, replaceBackup } from '../repositories/restore.repository.js';
import { DuplicateResourceError, NotFoundError } from '../utils/customErrors.js';
import { withAccountWriteLock } from '../utils/accountWriteLock.js';
import { currentRequestId, withRequestId } from '../utils/requestContext.js';
import { recordDiagnosticEvent } from '../utils/diagnosticLog.js';

type Result = Awaited<ReturnType<typeof replaceBackup>>;
type Job = {
  id: string;
  owner: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: Result | null;
  progress: { phase: string; completed: number; total: number } | null;
};

export async function previewRestore(backup: PreviewBackupBody, userId?: string) {
  return previewBackupConflicts(backup, userId);
}

const scheduled = new Set<string>();
const progressByJob = new Map<string, Job['progress']>();
const RESTORE_CANCELLATION_GRACE_MS = 3_000;

function publicJob(row: { id: string; owner: string; state: string; result: string | null }): Job {
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(row.state))
    throw new Error('Invalid persisted restore state');
  return {
    id: row.id,
    owner: row.owner,
    state: row.state as Job['state'],
    result: row.result ? (JSON.parse(row.result) as Result) : null,
    progress: progressByJob.get(row.id) ?? null,
  };
}

function schedule(id: string, requestId = currentRequestId()): void {
  if (scheduled.has(id)) return;
  scheduled.add(id);
  // Keep a short queued window so the client can present a real pre-commit cancel action.
  setTimeout(() => {
    const execution = () => run(id);
    const result = requestId ? withRequestId(requestId, execution) : execution();
    void result
      .catch(() =>
        recordDiagnosticEvent({
          level: 'error',
          area: 'restore',
          event: 'restore.job_runner_failed',
          requestId,
          jobId: id,
          code: 'RESTORE_FAILED',
        }),
      )
      .finally(() => scheduled.delete(id));
  }, RESTORE_CANCELLATION_GRACE_MS);
}

async function run(id: string): Promise<void> {
  const claimed = await prisma.restore_job.updateMany({
    where: { id, state: 'queued' },
    data: { state: 'running' },
  });
  if (claimed.count !== 1) return;
  const row = await prisma.restore_job.findUniqueOrThrow({ where: { id } });
  try {
    const backup = JSON.parse(row.payload) as ReplaceBackupBody;
    const total =
      backup.manga.length +
      backup.library.length +
      backup.history.length +
      backup.manga.reduce((sum, entry) => sum + entry.chapters.length, 0);
    progressByJob.set(id, { phase: 'Preparing restore', completed: 0, total });
    // The repository commits the final job state in the same transaction as the data.
    await withAccountWriteLock(row.owner, () =>
      replaceBackup(
        backup,
        row.owner === 'anonymous' ? undefined : row.owner,
        id,
        (completed, count, phase) => {
          progressByJob.set(id, { phase, completed, total: count });
        },
      ),
    );
    progressByJob.delete(id);
  } catch {
    recordDiagnosticEvent({
      level: 'error',
      area: 'restore',
      event: 'restore.transaction_failed',
      requestId: row.request_id ?? currentRequestId(),
      jobId: id,
      code: 'RESTORE_FAILED',
    });
    await prisma.restore_job.updateMany({
      where: { id, state: 'running' },
      data: { state: 'failed', payload: '' },
    });
    progressByJob.delete(id);
  }
}

export async function startRestore(backup: ReplaceBackupBody, userId?: string): Promise<Job> {
  const owner = userId ?? 'anonymous';
  const requestId = currentRequestId() ?? null;
  const payload = JSON.stringify(backup);
  const row = await withAccountWriteLock(owner, () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.restore_job.findUnique({ where: { id: backup.jobId } });
      if (existing) {
        if (existing.owner !== owner || (existing.payload && existing.payload !== payload))
          throw new NotFoundError('Restore job not found');
        return existing;
      }
      const active = await tx.restore_job.findFirst({
        where: { owner, state: { in: ['queued', 'running'] } },
        select: { id: true },
      });
      if (active) throw new DuplicateResourceError('A restore is already running for this library');
      return tx.restore_job.create({
        data: { id: backup.jobId, owner, request_id: requestId, state: 'queued', payload },
      });
    }),
  );
  if (row.state === 'queued') {
    recordDiagnosticEvent({
      level: 'info',
      area: 'restore',
      event: 'restore.job_queued',
      requestId: row.request_id ?? requestId,
      jobId: row.id,
    });
    schedule(row.id, row.request_id ?? requestId ?? undefined);
  }
  return publicJob(row);
}

export async function getRestore(id: string, userId?: string): Promise<Job> {
  const row = await prisma.restore_job.findUnique({ where: { id } });
  if (!row || row.owner !== (userId ?? 'anonymous'))
    throw new NotFoundError('Restore job not found');
  return publicJob(row);
}

/** Cancels only jobs that have not been claimed by the worker; running replacement stays atomic. */
export async function cancelRestore(id: string, userId?: string): Promise<Job> {
  const owner = userId ?? 'anonymous';
  await prisma.restore_job.updateMany({
    where: { id, owner, state: 'queued' },
    data: { state: 'cancelled', payload: '' },
  });
  return getRestore(id, userId);
}

/** Resume interrupted work before the API starts accepting requests. */
export async function recoverRestoreJobs(): Promise<void> {
  await prisma.restore_job.updateMany({ where: { state: 'running' }, data: { state: 'queued' } });
  const queued = await prisma.restore_job.findMany({
    where: { state: 'queued' },
    select: { id: true, request_id: true },
    orderBy: { created_at: 'asc' },
  });
  for (const job of queued) {
    recordDiagnosticEvent({
      level: 'info',
      area: 'restore',
      event: 'restore.job_recovered',
      requestId: job.request_id,
      jobId: job.id,
    });
    schedule(job.id, job.request_id ?? undefined);
  }
}
