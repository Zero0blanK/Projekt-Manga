/**
 * The states of a library restore job, and what they mean, for every tier: the server
 * that runs the job, the web app that tracks it, and the desktop that syncs around it.
 *
 *   queued ──▶ running ──▶ succeeded
 *      │          └──────▶ failed
 *      └──▶ cancelled
 *
 * A job is `queued` for a short window in which it can still be cancelled; once `running`
 * the restore is one transaction and ends as `succeeded` or `failed`. A job found
 * `running` when the server starts was interrupted, and goes back to `queued` (or to
 * `failed` after too many attempts).
 */
export const RESTORE_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

export type RestoreState = (typeof RESTORE_STATES)[number];

/** The states in which a restore still holds its library: no second restore may start,
 * and a device's sync push is refused until it ends. */
export const ACTIVE_RESTORE_STATES = [
  'queued',
  'running',
] as const satisfies readonly RestoreState[];

export function isRestoreState(value: unknown): value is RestoreState {
  return typeof value === 'string' && (RESTORE_STATES as readonly string[]).includes(value);
}

export function isRestoreActive(state: RestoreState): boolean {
  return (ACTIVE_RESTORE_STATES as readonly RestoreState[]).includes(state);
}

/**
 * Why the server refused a sync push with 409, as the `code` beside the message. A device
 * acts on these (one means "take the restored library first"), so it is told by code, not
 * by matching the message's wording.
 */
export const SYNC_CONFLICT = {
  /** A restore replaced the account's library since this device last synced. */
  resetRequired: 'SYNC_RESET_REQUIRED',
  /** A restore is queued or running; try again when it ends. */
  restoreInProgress: 'RESTORE_IN_PROGRESS',
} as const;

export type SyncConflictCode = (typeof SYNC_CONFLICT)[keyof typeof SYNC_CONFLICT];
