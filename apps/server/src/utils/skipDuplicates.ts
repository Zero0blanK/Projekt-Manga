/**
 * Replacement for Prisma's `createMany({ skipDuplicates: true })`, which the SQLite
 * connector does not support (the option is typed `never` there).
 *
 * The pattern at every call site is: read the keys that already exist, drop those rows,
 * then `createMany` the rest. That is one extra SELECT per batch, which is cheap next to
 * the alternative of an upsert per row.
 *
 * What this deliberately does *not* reproduce is `skipDuplicates`'s atomicity. Between the
 * SELECT and the INSERT another writer could insert the same key, and the INSERT would
 * then fail on the unique constraint rather than skipping. Every caller here either runs
 * inside a transaction or is a one-shot claim/merge that is not run concurrently with
 * itself, and the app is single-user per database — so the window is not reachable in
 * practice. Worth knowing before reusing this somewhere genuinely concurrent.
 *
 * The `IN (...)` lists these produce are not chunked; this app's batches (a few thousand
 * chapters at most) are far below any limit.
 */

/**
 * Returns the rows whose key is not in `existing`.
 *
 * Also removes duplicates *within* `rows`. `skipDuplicates` did that too, and a plain
 * `createMany` does not — it fails the whole batch on the unique constraint — so leaving
 * it out would turn a silently-tolerated input into a hard error.
 */
export function excludeExisting<TRow>(
  rows: readonly TRow[],
  existing: Iterable<string>,
  keyOf: (row: TRow) => string,
): TRow[] {
  const seen = new Set<string>(existing);
  const out: TRow[] = [];

  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  return out;
}

/**
 * Joins parts into one lookup key for a composite unique.
 *
 * NUL is the separator because it cannot occur in any identifier this app stores, so two
 * different composites can never flatten into the same key. A printable separator would
 * have to be argued about per call site; this one does not.
 */
export function compositeKey(...parts: (string | number | null)[]): string {
  return parts.map((p) => (p === null ? '\u0000null' : String(p))).join('\u0000');
}
