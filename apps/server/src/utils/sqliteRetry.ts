/**
 * Retries a database operation that lost a write race.
 *
 * SQLite serialises writers. `busy_timeout` (see configs/prisma.config.ts) absorbs most
 * contention by making the loser wait, but a writer that is still blocked when the timeout
 * expires gets `SQLITE_BUSY` — and under WAL a writer that started while another
 * transaction was open can get `SQLITE_BUSY_SNAPSHOT` immediately, without waiting at all.
 *
 * Neither is a real failure: the correct response is to try again. Left unhandled, they
 * surface as occasional unexplained 500s during a download sweep.
 *
 * Only wraps whole operations, never a partial transaction — retrying half a transaction
 * would apply some writes twice. Every caller passes an idempotent unit of work.
 */

/** Error codes that mean "the database was busy, try again" rather than "this was wrong". */
const RETRYABLE = [
  'SQLITE_BUSY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_LOCKED',
  'database is locked',
  'P2034',
];

const MAX_ATTEMPTS = 5;
/** First backoff step. Doubles each attempt with jitter, so ~25ms + 50 + 100 + 200 in the
 * worst case — under a second in total, well inside a request's patience. */
const BASE_DELAY_MS = 25;

export function isBusyError(error: unknown): boolean {
  // The code can arrive as `error.code` or only inside the message, depending on whether
  // Prisma or the driver produced the error, so both are checked.
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return RETRYABLE.some(
    (needle) =>
      (typeof code === 'string' && code.toUpperCase().includes(needle.toUpperCase())) ||
      message.toUpperCase().includes(needle.toUpperCase()),
  );
}

export async function withBusyRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isBusyError(error)) {
        // Anything else is a real error and must surface unchanged — swallowing it here
        // is how a constraint violation turns into a mystery timeout.
        throw error;
      }
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;

      // Jittered so two writers that collided don't wake together and collide again.
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.warn(`[db] ${label} still busy after ${MAX_ATTEMPTS} attempts`);
  throw lastError;
}
