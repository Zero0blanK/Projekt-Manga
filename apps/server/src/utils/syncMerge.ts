/**
 * Shared control flow for the "plain last-write-wins" half of the sync merge rules (see
 * sync.service.ts's doc comment) — `userLibrary`, `userMangaState`, and
 * `userMangaCategory` repositories all share this "compare updated_at, write or skip"
 * shape. `userChapterState`'s `mergeIncoming` is
 * deliberately not built on this: its monotonic-union rule always writes regardless of
 * which side is newer, so it has no "skip" branch to share.
 *
 * The comparison happens **inside** the write, not before it. A find-then-compare-then-
 * upsert is a read-modify-write with no transaction: two devices pushing the same row
 * concurrently could both write, and the winner would be whichever committed last rather
 * than whichever carried the newer `updated_at`. Pushing the predicate into the UPDATE's
 * own WHERE clause makes the decision and the write a single atomic statement.
 */

/** Prisma's unique-constraint violation. Duck-typed rather than imported so this stays
 * usable under the test suite's mocked Prisma client, which throws plain objects. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

/**
 * WHERE fragment for "the stored row was last edited before `incoming`". A row's edit time
 * is `edited_at` when a sync push set it (the editing device's own time), otherwise
 * `updated_at` (a direct write on this server, made at the time it was stored). Comparing
 * the server's arrival time against a device's edit time would let a late-synced edit beat
 * a newer one.
 */
export function editedBefore(incoming: Date) {
  return {
    OR: [{ edited_at: { lt: incoming } }, { edited_at: null, updated_at: { lt: incoming } }],
  };
}

export interface LastWriteWinsResult {
  /** False when the stored row was newer than the incoming one and was left alone. */
  applied: boolean;
}

export async function applyLastWriteWins(params: {
  /** An `updateMany` whose WHERE carries both the row's key and
   * `updated_at: { lt: <incoming> }`, so it matches only when the incoming write is
   * genuinely newer. Returns Prisma's `{ count }`. */
  updateIfOlder: () => Promise<{ count: number }>;
  /** Creates the row. Only reached when the update matched nothing, which means either
   * the row doesn't exist yet or it exists and is newer — the unique constraint is what
   * tells those two apart, and it does so atomically. */
  create: () => Promise<unknown>;
}): Promise<LastWriteWinsResult> {
  const { count } = await params.updateIfOlder();
  if (count > 0) {
    return { applied: true };
  }

  try {
    await params.create();
    return { applied: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The row exists and the update didn't match it, so the stored copy is newer.
      // Skipping is the correct last-write-wins outcome, not a failure.
      return { applied: false };
    }
    throw error;
  }
}
