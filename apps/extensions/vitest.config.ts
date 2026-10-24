import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts', 'sources/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['**/*.ts'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        'sources/**/__tests__/**',
        'templates/**',
        'vitest.config.ts',
        '**/*.d.ts',
      ],
    },
  },
});
