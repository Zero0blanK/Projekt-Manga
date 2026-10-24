import { defineConfig } from 'vitest/config';
import { migrationTestFiles } from './vitest.migrations.config';

export default defineConfig({
  // Unit tests mock Prisma and set only the environment values their individual cases
  // need. Loading the developer's .env would make that isolation accidental and can
  // point a test process at real local configuration.
  envFile: false,
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Migration suites run separately: `npm run test:migrations`.
    exclude: ['tests/integration/**', 'node_modules/**', ...migrationTestFiles],
    testTimeout: 10000,
  },
});
