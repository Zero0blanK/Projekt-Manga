/**
 * Holds reading-progress writes to the server while a library restore runs.
 *
 * A restore applies the whole backup in one database transaction, and SQLite lets nothing
 * else write until it ends. A progress save sent meanwhile waited for the lock and failed,
 * so the app used to block reading for the duration. Reading now carries on: each save
 * waits here instead, and when the restore ends only the newest save for each chapter is
 * sent, after the restored data, so what was read during the restore is kept.
 *
 * Only for the server path. The desktop app saves progress to its own database first and
 * keeps it through a restore itself (apps/desktop/src/main/db/local-store.ts).
 */

/** Returns a promise while writes must wait, settling when they may go; else null. */
export type ProgressWriteHold = () => Promise<void> | null;

let hold: ProgressWriteHold | null = null;
let tickets = 0;
const newestByKey = new Map<string, number>();

/** Installed by the app (see apps/web/src/lib/api-config.ts). */
export function setProgressWriteHold(next: ProgressWriteHold | null): void {
  hold = next;
}

/**
 * Waits while writes are held. Resolves true when this write should be sent, false when a
 * newer write for the same `key` (one chapter) was made while it waited and replaces it.
 */
export async function awaitProgressWrite(key: string): Promise<boolean> {
  const waiting = hold?.();
  if (!waiting) return true;
  const ticket = ++tickets;
  newestByKey.set(key, ticket);
  await waiting;
  if (newestByKey.get(key) !== ticket) return false;
  newestByKey.delete(key);
  return true;
}
