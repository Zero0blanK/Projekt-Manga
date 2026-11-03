import { vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { prismaMock, resetPrismaMock } from './mocks/prismaMock.js';
import { setSuwayomiSettingsFileForTests } from '../src/services/suwayomi/settings.js';

// Applies to every test file (Vitest re-runs setupFiles per test file, each with its own
// module registry) — no test ever touches a real database.
vi.mock('../src/configs/prisma.config.js', () => ({ default: prismaMock }));

beforeEach(() => {
  resetPrismaMock(prismaMock);
  // Never the reader's own Suwayomi connection beside their database: no test may reach a
  // real server. suwayomi.test.ts points this at its own temp file.
  setSuwayomiSettingsFileForTests(path.join(os.tmpdir(), 'pm-no-suwayomi', 'suwayomi.json'));
});
