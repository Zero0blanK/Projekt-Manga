import { vi, beforeEach } from 'vitest';
import { prismaMock, resetPrismaMock } from './mocks/prismaMock.js';

// Applies to every test file (Vitest re-runs setupFiles per test file, each with its own
// module registry) — no test ever touches a real database.
vi.mock('../src/configs/prisma.config.js', () => ({ default: prismaMock }));

beforeEach(() => {
  resetPrismaMock(prismaMock);
});
