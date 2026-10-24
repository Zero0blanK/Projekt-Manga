import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import prisma from '../../src/configs/prisma.config.js';
import { RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';

const scenarios = [
  { scenario: 'titles', titles: 10_000, chapters: 0, history: 0 },
  { scenario: 'chapters', titles: 1, chapters: 50_000, history: 0 },
  { scenario: 'history', titles: 0, chapters: 0, history: 50_000 },
] as const;

describe('restore row-envelope benchmarks (disposable SQLite)', () => {
  it.each(scenarios)(
    'measures the $scenario schema maximum below the upload limit and write budget',
    async ({ scenario, titles, chapters, history }) => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('DATABASE_URL must point at the disposable integration DB');
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'tests/integration/restore-envelope-worker.ts', scenario],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 120_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            DATABASE_URL: databaseUrl,
          },
        },
      );
      expect(child.error, child.error?.message).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const reportLine = child.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('[restore-envelope] '));
      expect(reportLine, child.stdout).toBeDefined();
      const report = JSON.parse(reportLine!.slice('[restore-envelope] '.length)) as {
        scenario: string;
        titles: number;
        chapters: number;
        library: number;
        history: number;
        payloadBytes: number;
        restoreMs: number;
        writerWaitMs: number;
        peakRssDeltaBytes: number;
      };

      expect(report).toMatchObject({ scenario, titles, chapters, library: titles, history });
      expect(report.payloadBytes).toBeLessThanOrEqual(RESTORE_UPLOAD_LIMIT_BYTES);
      expect(report.restoreMs).toBeLessThan(10_000);
      expect(report.writerWaitMs).toBeLessThan(10_000);
      expect(report.peakRssDeltaBytes).toBeGreaterThan(0);
      expect(await prisma.manga.count({ where: { source: `restore-envelope-${scenario}` } })).toBe(
        titles,
      );
      expect(await prisma.chapter.count()).toBe(chapters);
      expect(await prisma.history.count({ where: { source: 'restore-envelope-history' } })).toBe(
        history,
      );
      console.info(`[restore-envelope] ${JSON.stringify(report)}`);
    },
    120_000,
  );
});
