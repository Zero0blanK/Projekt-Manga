import { vi } from 'vitest';

/**
 * A hand-rolled deep mock of the Prisma client.
 *
 * These tests verify the HTTP layer end-to-end — routing, validation, error-status
 * mapping, response shape — with the database boundary stubbed, which keeps them fast and
 * independent of any on-disk state. Each test configures the specific find/create/update
 * calls it needs via `.mockResolvedValueOnce(...)` etc.
 *
 * A mock cannot tell you what the real engine does, so anything that depends on actual
 * database behaviour — collation, constraint enforcement, SQL the mock would happily
 * accept — belongs in `tests/integration/` instead. Those run against a real SQLite file
 * and skip importing this mock; see `vitest.integration.config.ts`.
 */
function createModelMock() {
  return {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  };
}

export type ModelMock = ReturnType<typeof createModelMock>;

export interface PrismaMock {
  manga: ModelMock;
  manga_detail: ModelMock;
  chapter: ModelMock;
  category: ModelMock;
  manga_category: ModelMock;
  manga_library: ModelMock;
  download: ModelMock;
  history: ModelMock;
  cache: ModelMock;
  user: ModelMock;
  session: ModelMock;
  device: ModelMock;
  user_library: ModelMock;
  user_manga_state: ModelMock;
  user_chapter_state: ModelMock;
  user_manga_category: ModelMock;
  restore_job: ModelMock;
  extension_repository: ModelMock;
  installed_extension: ModelMock;
  tracker_account: ModelMock;
  tracker_link: ModelMock;
  $transaction: ReturnType<typeof vi.fn>;
  /** Used by the readiness probe's `SELECT 1`, and by the startup pragmas. */
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
}

export function createPrismaMock(): PrismaMock {
  const mock = {
    manga: createModelMock(),
    manga_detail: createModelMock(),
    chapter: createModelMock(),
    category: createModelMock(),
    manga_category: createModelMock(),
    manga_library: createModelMock(),
    download: createModelMock(),
    history: createModelMock(),
    cache: createModelMock(),
    user: createModelMock(),
    session: createModelMock(),
    device: createModelMock(),
    user_library: createModelMock(),
    user_manga_state: createModelMock(),
    user_chapter_state: createModelMock(),
    user_manga_category: createModelMock(),
    restore_job: createModelMock(),
    extension_repository: createModelMock(),
    installed_extension: createModelMock(),
    tracker_account: createModelMock(),
    tracker_link: createModelMock(),
  } as PrismaMock;

  for (const key of Object.keys(mock) as (keyof PrismaMock)[]) {
    applyBatchDefaults(mock[key] as ModelMock);
  }

  // Supports both the callback form ($transaction(async (tx) => ...), used throughout
  // this codebase) and the array-of-promises form, by just running against the same mock.
  mock.$transaction = vi.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaMock) => unknown)(mock);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  // Resolve by default: a readiness check against this mock means "reachable". Tests that
  // care about the failure path override it with mockRejectedValueOnce.
  mock.$queryRawUnsafe = vi.fn(async () => [{ 1: 1 }]);
  mock.$executeRawUnsafe = vi.fn(async () => 0);

  return mock;
}

/** Shared singleton — import this in tests to configure return values; setup.ts wires it
 * up as the mocked default export of configs/prisma.config.ts. */
export const prismaMock = createPrismaMock();

/**
 * Prisma's batch operations always resolve to a `{ count }` payload, and callers
 * destructure it. A bare `vi.fn()` resolves to `undefined`, so any code path reaching one
 * of these without an explicit per-test mock failed with "Cannot destructure property
 * 'count'" — an artefact of the mock rather than anything about the code. Defaulting to
 * "matched nothing" keeps those paths honest: a test that cares about the count still
 * sets its own.
 */
function applyBatchDefaults(model: ModelMock): void {
  model.createMany.mockResolvedValue({ count: 0 });
  model.updateMany.mockResolvedValue({ count: 0 });
  model.deleteMany.mockResolvedValue({ count: 0 });
  // Same reasoning as the counts above: real
  // `findMany` never resolves to `undefined`, it resolves to `[]`. An unconfigured mock
  // returning `undefined` made every `for (const x of await findMany(...))` throw "found
  // is not iterable" in code that is correct — an artefact of the mock, not a bug.
  model.findMany.mockResolvedValue([]);
}

/** Resets every mocked method's calls/return values without discarding the mock object
 * identity (so `vi.mock` factories that capture it by reference stay valid). */
export function resetPrismaMock(mock: PrismaMock): void {
  for (const key of Object.keys(mock) as (keyof PrismaMock)[]) {
    if (key === '$queryRawUnsafe' || key === '$executeRawUnsafe') {
      const raw = mock[key] as ReturnType<typeof vi.fn>;
      raw.mockReset();
      raw.mockImplementation(async () => (key === '$queryRawUnsafe' ? [{ 1: 1 }] : 0));
      continue;
    }
    if (key === '$transaction') {
      continue;
    }
    const model = mock[key] as ModelMock;
    for (const fn of Object.values(model)) {
      fn.mockReset();
    }
    applyBatchDefaults(model);
  }
  mock.$transaction.mockReset();
  mock.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaMock) => unknown)(mock);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}
