import { defineConfig } from 'vitest/config';

// Runs against a real SQLite database — no Prisma mocking. Separate from vitest.config.ts
// so the default `npm test` stays fast and needs no database at all.
//
// Requires DATABASE_URL to name a disposable database (one containing "test" or "ci") with
// migrations already applied; tests/integration/setup.ts enforces that, because these tests
// truncate every table. Use a disposable SQLite database for integration tests.
export default defineConfig({
  envFile: false,
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/integration/setup.ts'],
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 20000,
    // These hit a shared database — run them one at a time to keep truncate/seed
    // steps from racing each other.
    fileParallelism: false,
  },
});
