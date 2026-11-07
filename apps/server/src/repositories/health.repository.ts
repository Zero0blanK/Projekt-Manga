import prisma from '../configs/prisma.config.js';

/** Throws when the database can't answer. `SELECT 1` needs no table to exist, so this
 * reports "reachable" without also asserting a particular schema. */
const ping = async () => {
  await prisma.$queryRawUnsafe('SELECT 1');
};

/** One count for the runtime report, or null when the table can't be read: itself a signal
 * when the schema is the problem. Fixed SQL only; nothing here takes input. */
const countRows = async (sql: string): Promise<number | null> => {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(sql);
    return Number(rows[0]?.n ?? 0);
  } catch {
    return null;
  }
};

const listMigrations = async () =>
  prisma.$queryRawUnsafe<
    Array<{ migration_name: string; finished_at: unknown; rolled_back_at: unknown }>
  >(
    'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at',
  );

const countDownloadsByStatus = async () =>
  prisma.$queryRawUnsafe<Array<{ status: string; n: bigint | number }>>(
    'SELECT status, COUNT(*) AS n FROM downloads GROUP BY status',
  );

const healthRepository = { ping, countRows, listMigrations, countDownloadsByStatus };

export default healthRepository;
