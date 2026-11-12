import type { PreviewBackupBody, ReplaceBackupBody } from '@projekt-manga/schemas';
import { isRestoreState, type RestoreState } from '@projekt-manga/types';
import { previewBackupConflicts, replaceBackup } from '../repositories/restore.repository.js';
import restoreJobRepository from '../repositories/restoreJob.repository.js';
import { NotFoundError } from '../utils/customErrors.js';
import { withAccountWriteLock } from '../utils/accountWriteLock.js';
import { currentRequestId, withRequestId } from '../utils/requestContext.js';
import { recordDiagnosticEvent } from '../utils/diagnosticLog.js';

type Result = Awaited<ReturnType<typeof replaceBackup>>;
type Job = {
  id: string;
  owner: string;
  state: RestoreState;
  result: Result | null;
  progress: { phase: string; completed: number; total: number } | null;
};

export async function previewRestore(backup: PreviewBackupBody, userId?: string) {
  return previewBackupConflicts(backup, userId);
}

const scheduled = new Set<string>();
const progressByJob = new Map<string, Job['progress']>();
const RESTORE_CANCELLATION_GRACE_MS = 3_000;
const FINISHED_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function publicJob(row: { id: string; owner: string; state: string; result: string | null }): Job {
  if (!isRestoreState(row.state)) throw new Error('Invalid persisted restore state');
  return {
    id: row.id,
    owner: row.owner,
    state: row.state,
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
  if (!(await restoreJobRepository.claim(id))) return;
  const row = await restoreJobRepository.getByIdOrThrow(id);
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
    await restoreJobRepository.markFailed(id);
    progressByJob.delete(id);
  }
}

export async function startRestore(backup: ReplaceBackupBody, userId?: string): Promise<Job> {
  const owner = userId ?? 'anonymous';
  const requestId = currentRequestId() ?? null;
  const payload = JSON.stringify(backup);
  const row = await withAccountWriteLock(owner, () =>
    restoreJobRepository.createOrGetExisting({
      id: backup.jobId,
      owner,
      request_id: requestId,
      payload,
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
  const row = await restoreJobRepository.getById(id);
  if (!row || row.owner !== (userId ?? 'anonymous'))
    throw new NotFoundError('Restore job not found');
  return publicJob(row);
}

/** Cancels only jobs that have not been claimed by the worker; running replacement stays atomic. */
export async function cancelRestore(id: string, userId?: string): Promise<Job> {
  const owner = userId ?? 'anonymous';
  await restoreJobRepository.cancelQueued(id, owner);
  return getRestore(id, userId);
}

/** Resume interrupted work before the API starts accepting requests. */
export async function recoverRestoreJobs(): Promise<void> {
  await restoreJobRepository.pruneFinished(new Date(Date.now() - FINISHED_JOB_RETENTION_MS));
  const { queued, abandoned } = await restoreJobRepository.requeueInterrupted();
  for (const job of abandoned) {
    recordDiagnosticEvent({
      level: 'error',
      area: 'restore',
      event: 'restore.job_abandoned',
      requestId: job.request_id,
      jobId: job.id,
      code: 'RESTORE_INTERRUPTED',
    });
  }
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
