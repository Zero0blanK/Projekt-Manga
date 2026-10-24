import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import prisma from '../../src/configs/prisma.config.js';
import { replaceBackup } from '../../src/repositories/restore.repository.js';
import { replaceBackupBodySchema, RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';
import request from 'supertest';
import app from '../../src/app.js';
import {
  cancelRestore,
  recoverRestoreJobs,
  startRestore,
} from '../../src/services/restore.service.js';
import syncService from '../../src/services/sync.service.js';

const empty = replaceBackupBodySchema.parse({
  jobId: '9e88e805-88c9-4eb4-b00a-f99ab675583b',
  expectedUserId: null,
  version: 2,
  manga: [],
  library: [],
  history: [],
});

const manga = (id: string, slug: string, chapterId: string) => ({
  id,
  source: 'test-source',
  slug,
  title: slug,
  author: 'Author',
  thumbnail_url: 'https://example.com/cover.jpg',
  artist: null,
  description: '',
  genres: '',
  status: 'ONGOING',
  rating: null,
  chapters: [
    {
      id: chapterId,
      url: 'https://example.com/chapter',
      name: 'Chapter',
      scanlator: null,
      chapter_number: 1,
      last_page_read: 4,
      is_read: false,
      is_bookmark: false,
      release_date: null,
      page_count: 10,
    },
  ],
});

describe('transactional replace backup (real SQLite)', () => {
  it('accepts and durably queues a valid restore at the exact JSON upload byte limit', async () => {
    const backup = replaceBackupBodySchema.parse({
      ...empty,
      manga: [manga('limit-title', 'limit-title', 'limit-chapter')],
    });
    backup.manga[0].description = 'x'.repeat(
      RESTORE_UPLOAD_LIMIT_BYTES - Buffer.byteLength(JSON.stringify(backup)),
    );
    const exactLimitBody = JSON.stringify(backup);
    expect(Buffer.byteLength(exactLimitBody)).toBe(RESTORE_UPLOAD_LIMIT_BYTES);
    const response = await request(app)
      .post('/api/restore/jobs')
      .set('Content-Type', 'application/json')
      .send(exactLimitBody);

    expect(response.status).toBe(202);
    const queued = await prisma.restore_job.findUniqueOrThrow({ where: { id: backup.jobId } });
    expect(Buffer.byteLength(queued.payload)).toBe(RESTORE_UPLOAD_LIMIT_BYTES);
    expect(JSON.parse(queued.payload)).toEqual(backup);
    expect((await cancelRestore(backup.jobId)).state).toBe('cancelled');
  }, 30_000);

  it('admits only one concurrent restore for a library', async () => {
    const submissions = await Promise.allSettled(
      ['7e73fcbc-971f-4f7c-9cf8-69c8ca4c30dd', '7d4830a9-a1f7-4d69-a95f-a788696def8d'].map(
        (jobId) => startRestore({ ...empty, jobId }),
      ),
    );
    const accepted = submissions.filter((submission) => submission.status === 'fulfilled');
    const rejected = submissions.filter((submission) => submission.status === 'rejected');

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
      'A restore is already running for this library',
    );

    const job = (accepted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startRestore>>>)
      .value;
    expect(job.state).toBe('queued');
    expect((await cancelRestore(job.id)).state).toBe('cancelled');
  });

  it('measures a representative restore fixture and a competing SQLite writer', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL must point at the disposable integration DB');
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'tests/integration/restore-benchmark-worker.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 120_000,
        // Pass only the explicitly selected disposable database and runtime essentials.
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
      .find((line) => line.startsWith('[restore-benchmark] '));
    expect(reportLine, child.stdout).toBeDefined();
    const report = JSON.parse(reportLine!.slice('[restore-benchmark] '.length)) as {
      titles: number;
      chapters: number;
      library: number;
      history: number;
      payloadBytes: number;
      restoreMs: number;
      writerWaitMs: number;
      peakRssDeltaBytes: number;
    };

    expect(report).toMatchObject({
      titles: 3_200,
      chapters: 16_000,
      library: 3_200,
      history: 16_000,
      payloadBytes: RESTORE_UPLOAD_LIMIT_BYTES,
    });
    expect(report.restoreMs).toBeLessThan(10_000);
    expect(report.writerWaitMs).toBeLessThan(10_000);
    expect(report.peakRssDeltaBytes).toBeGreaterThan(0);
    expect(await prisma.chapter.count()).toBe(report.chapters);
    expect(await prisma.history.count({ where: { source: 'restore-benchmark' } })).toBe(
      report.history,
    );
    console.info(`[restore-benchmark] ${JSON.stringify(report)}`);
  }, 120_000);

  it('cancels a queued job before the worker claims it', async () => {
    const backup = { ...empty, jobId: '637f9e36-fb3c-47fd-8c00-eb58b4ac0918' };
    await prisma.restore_job.create({
      data: {
        id: backup.jobId,
        owner: 'anonymous',
        state: 'queued',
        payload: JSON.stringify(backup),
      },
    });
    const job = await cancelRestore(backup.jobId);
    expect(job.state).toBe('cancelled');
    const persisted = await prisma.restore_job.findUniqueOrThrow({ where: { id: backup.jobId } });
    expect(persisted.payload).toBe('');
  });

  it('reports determinate progress for imported titles and chapters', async () => {
    const backup = replaceBackupBodySchema.parse({
      ...empty,
      jobId: 'b42ed06b-9073-451f-890a-293b3e2ba067',
      manga: [manga('progress-title', 'progress-title', 'progress-chapter')],
    });
    const snapshots: Array<{ completed: number; total: number; phase: string }> = [];
    await replaceBackup(backup, undefined, undefined, (completed, total, phase) => {
      snapshots.push({ completed, total, phase });
    });
    expect(snapshots[0]).toMatchObject({ completed: 0, total: 2, phase: 'Preparing restore' });
    expect(snapshots.at(-1)).toMatchObject({ completed: 2, total: 2 });
  });

  it('recovers an interrupted durable job and commits its result with the restore', async () => {
    const backup = replaceBackupBodySchema.parse({
      ...empty,
      jobId: '37df11c4-dc5a-4a18-85d3-a93e5fe29c06',
      manga: [manga('recovered-title', 'recovered-title', 'recovered-chapter')],
      library: [
        {
          manga_id: 'recovered-title',
          is_bookmarked: false,
          shelf_status: 'READING',
          notification_read: false,
        },
      ],
    });
    await prisma.restore_job.create({
      data: {
        id: backup.jobId,
        owner: 'anonymous',
        state: 'running',
        payload: JSON.stringify(backup),
      },
    });
    await recoverRestoreJobs();
    let state = 'queued';
    let status: request.Response | undefined;
    for (let attempt = 0; attempt < 250 && state !== 'succeeded'; attempt++) {
      status = await request(app).get(`/api/restore/jobs/${backup.jobId}`);
      expect(status.status).toBe(200);
      state = status.body.data.state as string;
      if (state !== 'succeeded') await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state).toBe('succeeded');
    expect(status?.body.data.result).toMatchObject({ restoredManga: 1, restoredHistory: 0 });
    expect(
      await prisma.manga.findUnique({
        where: { source_slug: { source: 'test-source', slug: 'recovered-title' } },
      }),
    ).toMatchObject({ in_library: true });
    expect(await prisma.chapter.findUnique({ where: { id: 'recovered-chapter' } })).not.toBeNull();
    const persisted = await prisma.restore_job.findUniqueOrThrow({ where: { id: backup.jobId } });
    expect(JSON.parse(persisted.result ?? 'null')).toMatchObject({ restoredManga: 1 });
    expect(persisted.payload).toBe('');
  });

  it('merges without replacing an existing title or its chapter progress', async () => {
    const old = await prisma.manga.create({
      data: {
        source: 'test-source',
        slug: 'kept',
        title: 'Kept',
        author: 'A',
        thumbnail_url: '',
        in_library: true,
      },
    });
    await prisma.chapter.create({
      data: { id: 'kept-chapter', manga_id: old.id, url: '', chapter_number: 1, last_page_read: 9 },
    });
    const backup = replaceBackupBodySchema.parse({
      ...empty,
      mode: 'merge',
      manga: [
        manga('imported-kept', 'kept', 'kept-chapter'),
        manga('new', 'added', 'added-chapter'),
      ],
    });
    const result = await replaceBackup(backup);
    expect(result.restoredManga).toBe(1);
    expect(
      (await prisma.chapter.findUniqueOrThrow({ where: { id: 'kept-chapter' } })).last_page_read,
    ).toBe(9);
    expect((await prisma.manga.findUniqueOrThrow({ where: { id: old.id } })).title).toBe('Kept');
    expect(
      (
        await prisma.manga.findUniqueOrThrow({
          where: { source_slug: { source: 'test-source', slug: 'added' } },
        })
      ).in_library,
    ).toBe(true);
  });

  it('increments account generation on replace and rejects an older device push', async () => {
    const user = await prisma.user.create({
      data: { email: 'sync-reset@example.com', password_hash: 'fixture' },
    });
    await replaceBackup({ ...empty, expectedUserId: user.id }, user.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sync_generation).toBe(
      1,
    );
    await expect(syncService.push(user.id, { generation: 0 })).rejects.toThrow(
      /Sync reset required/,
    );
    await expect(syncService.push(user.id, { generation: 1 })).resolves.toMatchObject({
      chapter_state: { applied: 0, failed: [] },
    });
  });

  it('bulk restores account overlays without changing shared chapter progress', async () => {
    const user = await prisma.user.create({
      data: { email: 'restore-overlay@example.test', password_hash: 'fixture' },
    });
    const backup = replaceBackupBodySchema.parse({
      ...empty,
      expectedUserId: user.id,
      manga: [manga('overlay-import', 'overlay-title', 'overlay-chapter')],
      library: [
        {
          manga_id: 'overlay-import',
          is_bookmarked: true,
          shelf_status: 'READING',
          notification_read: false,
          score: 80,
        },
      ],
      history: [
        {
          source: 'test-source',
          manga_id: 'overlay-import',
          manga_slug: 'overlay-title',
          chapter_id: 'overlay-chapter',
          pages_read: 3,
          time_read: 1200,
          last_page_read: 2,
          is_read: true,
          read_at: '2026-09-01T00:00:00.000Z',
          last_read: '2026-09-01T00:00:00.000Z',
        },
      ],
    });

    await replaceBackup(backup, user.id);

    const mangaRow = await prisma.manga.findUniqueOrThrow({
      where: { source_slug: { source: 'test-source', slug: 'overlay-title' } },
      include: { chapter: true },
    });
    expect(mangaRow.in_library).toBe(false);
    expect(mangaRow.chapter[0]).toMatchObject({ id: 'overlay-chapter', last_page_read: 0 });
    expect(
      await prisma.user_library.findUnique({
        where: { user_id_manga_id: { user_id: user.id, manga_id: mangaRow.id } },
      }),
    ).toMatchObject({ deleted_at: null });
    expect(
      await prisma.user_manga_state.findUnique({
        where: { user_id_manga_id: { user_id: user.id, manga_id: mangaRow.id } },
      }),
    ).toMatchObject({ is_bookmarked: true, score: 80 });
    expect(
      await prisma.user_chapter_state.findUnique({
        where: { user_id_chapter_id: { user_id: user.id, chapter_id: 'overlay-chapter' } },
      }),
    ).toMatchObject({ is_read: true, last_page_read: 4 });
    expect(await prisma.history.count({ where: { user_id: user.id } })).toBe(1);
  });

  it('continues a queued HTTP restore after the start response returns', async () => {
    const old = await prisma.manga.create({
      data: {
        source: 'test-source',
        slug: 'old',
        title: 'Old',
        author: 'Author',
        thumbnail_url: 'https://example.com/cover.jpg',
        in_library: true,
      },
    });
    const jobId = 'ae4dc929-80e1-4ed4-8986-842b72e9b4ab';
    const start = await request(app)
      .post('/api/restore/jobs')
      .send({ ...empty, jobId });
    expect(start.status).toBe(202);
    let state = 'queued';
    const deadline = Date.now() + 10_000;
    while (state !== 'succeeded' && Date.now() < deadline) {
      const status = await request(app).get(`/api/restore/jobs/${jobId}`);
      expect(status.status).toBe(200);
      state = status.body.data.state as string;
      if (state !== 'succeeded') await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(state).toBe('succeeded');
    expect((await prisma.manga.findUnique({ where: { id: old.id } }))?.in_library).toBe(false);
  });

  it('keeps the highest chapter position when history contains an older snapshot', async () => {
    const backup = replaceBackupBodySchema.parse({
      ...empty,
      manga: [manga('imported', 'read-title', 'read-chapter')],
      history: [
        {
          source: 'test-source',
          manga_id: 'imported',
          manga_slug: 'read-title',
          chapter_id: 'read-chapter',
          pages_read: 2,
          time_read: 5,
          last_page_read: 2,
          is_read: false,
          read_at: '2026-09-01T00:00:00.000Z',
          last_read: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    await replaceBackup(backup);
    expect(
      (await prisma.chapter.findUnique({ where: { id: 'read-chapter' } }))?.last_page_read,
    ).toBe(4);
  });

  it('restores and counts a source-only saved position without adding a title to the library', async () => {
    const backup = replaceBackupBodySchema.parse({
      ...empty,
      history: [
        {
          source: 'test-source',
          manga_slug: 'preview-only',
          chapter_id: 'preview-chapter',
          pages_read: 3,
          time_read: 5,
          last_page_read: 3,
          is_read: false,
          read_at: '2026-09-01T00:00:00.000Z',
          last_read: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    const result = await replaceBackup(backup);
    expect(result.restoredProgress).toBe(1);
    expect(
      (await prisma.chapter.findUnique({ where: { id: 'preview-chapter' } }))?.last_page_read,
    ).toBe(3);
    expect(await prisma.manga.count({ where: { in_library: true } })).toBe(0);
  });

  it('rolls back removed membership and history if a chapter belongs to another title', async () => {
    const old = await prisma.manga.create({
      data: {
        source: 'test-source',
        slug: 'old',
        title: 'Old',
        author: 'Author',
        thumbnail_url: 'https://example.com/cover.jpg',
        in_library: true,
      },
    });
    await prisma.chapter.create({
      data: { id: 'occupied', manga_id: old.id, url: '', chapter_number: 1 },
    });
    await prisma.history.create({
      data: { source: 'test-source', manga_slug: 'old', manga_id: old.id },
    });
    const backup = replaceBackupBodySchema.parse({
      ...empty,
      manga: [manga('imported', 'new', 'occupied')],
    });
    await expect(replaceBackup(backup)).rejects.toThrow(/Chapter identity conflicts/);
    expect((await prisma.manga.findUnique({ where: { id: old.id } }))?.in_library).toBe(true);
    expect(await prisma.history.count({ where: { manga_id: old.id, deleted_at: null } })).toBe(1);
    expect(await prisma.manga.count({ where: { slug: 'new' } })).toBe(0);
  });

  it('replaces anonymous state without deleting account-owned history', async () => {
    const user = await prisma.user.create({
      data: { email: 'restore-test@example.com', password_hash: 'fixture' },
    });
    const old = await prisma.manga.create({
      data: {
        source: 'test-source',
        slug: 'old',
        title: 'Old',
        author: 'Author',
        thumbnail_url: 'https://example.com/cover.jpg',
        in_library: true,
      },
    });
    await prisma.history.create({
      data: { source: 'test-source', manga_slug: 'old', manga_id: old.id },
    });
    await prisma.history.create({
      data: { source: 'test-source', manga_slug: 'old', manga_id: old.id, user_id: user.id },
    });
    await replaceBackup(empty);
    expect((await prisma.manga.findUnique({ where: { id: old.id } }))?.in_library).toBe(false);
    expect(await prisma.history.count({ where: { user_id: null } })).toBe(0);
    expect(await prisma.history.count({ where: { user_id: user.id } })).toBe(1);
  });
});
