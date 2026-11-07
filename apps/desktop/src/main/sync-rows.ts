import type { PendingSyncPush } from './db/local-store';

/**
 * What the server's sync push accepts, checked here so one row can't sink a push.
 *
 * The server validates a push as a whole, so a single row it would refuse (written by an
 * older build, say) answers 400 for the entire request, and the same request is built
 * again next time: the device could never sync again. These mirror syncPushBodySchema in
 * packages/schemas/src/sync.ts, by hand because this package has no zod at runtime.
 */

type Domain = keyof PendingSyncPush;

export const PUSH_LIMITS: Record<Domain, number> = {
  library: 1000,
  manga_state: 1000,
  chapter_state: 5000,
  manga_category: 1000,
  history: 1000,
};

const SHELF_STATUSES = ['READING', 'COMPLETED', 'ON_HOLD', 'PLAN', 'DROPPED'];
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const text = (value: unknown, max = Infinity) =>
  typeof value === 'string' && value.length >= 1 && value.length <= max;
const nullableText = (value: unknown, max = Infinity) => value === null || text(value, max);
const time = (value: unknown) => typeof value === 'string' && ISO_TIME.test(value);
const nullableTime = (value: unknown) => value === null || time(value);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

const VALID: { [D in Domain]: (row: PendingSyncPush[D][number]) => boolean } = {
  library: (row) => text(row.manga_id) && nullableTime(row.deleted_at) && time(row.updated_at),
  manga_state: (row) =>
    text(row.manga_id) &&
    (row.shelf_status === null || SHELF_STATUSES.includes(row.shelf_status)) &&
    time(row.updated_at),
  chapter_state: (row) =>
    text(row.source, 255) &&
    text(row.manga_slug, 512) &&
    text(row.source_chapter_key, 512) &&
    count(row.last_page_read) &&
    time(row.updated_at),
  manga_category: (row) =>
    text(row.manga_id) &&
    text(row.category_name.trim(), 255) &&
    nullableTime(row.deleted_at) &&
    time(row.updated_at),
  history: (row) =>
    text(row.id) &&
    text(row.source) &&
    nullableText(row.manga_id) &&
    text(row.manga_slug) &&
    nullableText(row.title, 255) &&
    nullableText(row.source_chapter_key, 512) &&
    time(row.read_at) &&
    time(row.last_read) &&
    count(row.pages_read) &&
    count(row.time_read) &&
    nullableTime(row.deleted_at),
};

const DOMAINS = Object.keys(PUSH_LIMITS) as Domain[];

/** The rows the server would take, and how many it wouldn't. */
export function pushableRows(pending: PendingSyncPush): {
  rows: PendingSyncPush;
  rejected: number;
} {
  let rejected = 0;
  const rows = {} as Record<Domain, unknown[]>;
  for (const domain of DOMAINS) {
    const valid = VALID[domain] as (row: unknown) => boolean;
    rows[domain] = (pending[domain] as unknown[]).filter((row) => {
      const ok = valid(row);
      if (!ok) rejected += 1;
      return ok;
    });
  }
  return { rows: rows as unknown as PendingSyncPush, rejected };
}

const rowCount = (batch: PendingSyncPush) =>
  DOMAINS.reduce((total, domain) => total + batch[domain].length, 0);

/** Pushes small enough for the server's per-domain limits, in order. */
export function splitIntoBatches(pending: PendingSyncPush): PendingSyncPush[] {
  const batches: PendingSyncPush[] = [];
  for (let index = 0; ; index += 1) {
    const batch = {} as Record<Domain, unknown[]>;
    for (const domain of DOMAINS) {
      const limit = PUSH_LIMITS[domain];
      batch[domain] = (pending[domain] as unknown[]).slice(index * limit, (index + 1) * limit);
    }
    const typed = batch as unknown as PendingSyncPush;
    if (rowCount(typed) === 0) return batches;
    batches.push(typed);
  }
}

/** Two batches holding one batch's rows, for finding a row the server refused. Null when
 * there's only the one row left. */
export function halve(batch: PendingSyncPush): [PendingSyncPush, PendingSyncPush] | null {
  if (rowCount(batch) <= 1) return null;
  const first = {} as Record<Domain, unknown[]>;
  const second = {} as Record<Domain, unknown[]>;
  const middle = Math.ceil(rowCount(batch) / 2);
  let seen = 0;
  for (const domain of DOMAINS) {
    const rows = batch[domain] as unknown[];
    const split = Math.min(rows.length, Math.max(0, middle - seen));
    first[domain] = rows.slice(0, split);
    second[domain] = rows.slice(split);
    seen += rows.length;
  }
  return [first as unknown as PendingSyncPush, second as unknown as PendingSyncPush];
}
