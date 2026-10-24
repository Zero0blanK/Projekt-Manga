import { defineConfig } from 'vitest/config';

// The migration compatibility suites: they replay every committed migration (and, for the
// CLI suite, the real Prisma CLI) against throwaway SQLite files in the OS temp directory.
// Seconds locally but several minutes on a CI runner, where running them beside the unit
// suite starved its other tests into timeouts — so they are their own script and CI job.
//
// No DATABASE_URL is involved: every database here is a temp file the test creates.
export const migrationTestFiles = [
  'tests/migrateWithBackup.test.ts',
  'tests/migrationMatrix.test.ts',
  'tests/migrationPrismaCli.test.ts',
];

export default defineConfig({
  envFile: false,
  test: {
    environment: 'node',
    globals: false,
    // Same mock as the unit suite, so nothing here can reach a real database by accident.
    setupFiles: ['./tests/setup.ts'],
    include: migrationTestFiles,
    testTimeout: 10000,
  },
});
