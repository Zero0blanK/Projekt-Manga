import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // Tests use explicit mocks and jsdom state. Loading a developer's .env.local is both
  // unnecessary and blocked in restricted environments.
  envFile: false,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.tsx'],
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
