import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { replaceBackupBodySchema } from '@projekt-manga/schemas';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import mangaService from '../src/services/manga.service.js';
import libraryService from '../src/services/library.service.js';
import historyService from '../src/services/history.service.js';
import downloadService from '../src/services/download.service.js';
import { buildExport, createBackup, runScheduledBackups } from '../src/services/backup.service.js';
import { listBackups, pruneBackups, writeBackup } from '../src/utils/backupStore.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-backups-'));
  process.env.BACKUP_DIR = root;
  // No linked sources unless a test sets some up.
  prismaMock.manga_link.findMany.mockResolvedValue([] as never);
  // Shapes as the services return them: Dates, not strings, and nullable columns as null.
  vi.spyOn(mangaService, 'getManga').mockResolvedValue([{ id: 'm1' }, { id: 'gone' }] as never);
  // 'gone' was removed between the list and this read, so it isn't answered for.
  vi.spyOn(mangaService, 'getMangaDetailsByIds').mockResolvedValue([
    {
      id: 'm1',
      source: 'src',
      slug: 'title',
      title: 'Title',
      author: 'Author',
      thumbnail_url: 'https://example.com/c.jpg',
      in_library: true,
      created_at: new Date('2026-01-01T00:00:00Z'),
      status: 'ONGOING',
      genres: '',
      description: '',
      rating: null,
      artist: null,
      chapters: [
        {
          id: 'app-chapter-1',
          source_chapter_key: 'c1',
          manga_id: 'm1',
          url: 'https://example.com/1',
          name: 'One',
          scanlator: null,
          chapter_number: 1,
          last_page_read: 3,
          is_read: false,
          is_bookmark: false,
          release_date: new Date('2026-01-02T00:00:00Z'),
          page_count: null,
        },
      ],
    },
  ] as never);
  vi.spyOn(libraryService, 'getLibraryState').mockResolvedValue([
    { manga_id: 'm1', is_bookmarked: true, shelf_status: 'READING', notification_read: false },
    // A state row for a title no longer in the library must not poison the export.
    { manga_id: 'gone', is_bookmarked: false, shelf_status: null, notification_read: true },
  ] as never);
  vi.spyOn(historyService, 'getHistory').mockResolvedValue([
    {
      id: 'h1',
      source: 'src',
      manga_slug: 'title',
      manga_id: 'm1',
      source_chapter_key: 'c1',
      title: 'Title',
      read_at: new Date('2026-02-01T00:00:00Z'),
      last_read: new Date('2026-02-01T00:00:00Z'),
      last_page_read: 3,
      pages_read: 3,
    },
  ] as never);
  vi.spyOn(downloadService, 'getAllDownloads').mockResolvedValue([] as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.BACKUP_DIR;
  delete process.env.BACKUP_KEEP;
  delete process.env.BACKUP_INTERVAL_HOURS;
  delete process.env.ADMIN_TOKEN;
  await fs.rm(root, { recursive: true, force: true });
});

describe('server export', () => {
  it('produces a version-2 payload the restore schema accepts', async () => {
    const exported = await buildExport();
    const parsed = replaceBackupBodySchema.safeParse({
      ...exported,
      jobId: '9e88e805-88c9-4eb4-b00a-f99ab675583b',
      expectedUserId: null,
    });

    expect(parsed.success).toBe(true);
    expect(exported).toMatchObject({ version: 2, settings: null, downloads: [] });
    expect(exported.library).toEqual([expect.objectContaining({ manga_id: 'm1' })]);
    expect(exported.manga).toHaveLength(1);
  });

  it('is served for the session owner and refused when the owner changed', async () => {
    const ok = await request(app).get('/api/backup/export').query({ owner: 'anonymous' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body.data.version).toBe(2);
    expect(mangaService.getManga).toHaveBeenCalledWith({}, undefined);

    const changed = await request(app).get('/api/backup/export').query({ owner: 'user-1' });
    expect(changed.status).toBe(401);
  });
});

describe('backup files', () => {
  it('keeps only the newest N per owner', async () => {
    for (let day = 1; day <= 5; day++) {
      await writeBackup('anonymous', '{}', new Date(`2026-03-0${day}T00:00:00Z`));
    }
    await writeBackup('other', '{}', new Date('2026-01-01T00:00:00Z'));

    const removed = await pruneBackups('anonymous', 2);

    expect(removed).toHaveLength(3);
    const kept = await listBackups('anonymous');
    expect(kept.map((file) => file.createdAt)).toEqual([
      '2026-03-05T00:00:00.000Z',
      '2026-03-04T00:00:00.000Z',
    ]);
    // Another owner's folder is never touched by this owner's retention.
    expect(await listBackups('other')).toHaveLength(1);
  });

  it('prunes to the configured count after each backup', async () => {
    process.env.BACKUP_KEEP = '1';
    await writeBackup('anonymous', '{}', new Date('2020-01-01T00:00:00Z'));
    await createBackup();

    const files = await listBackups('anonymous');
    expect(files).toHaveLength(1);
    expect(files[0].createdAt > '2020').toBe(true);
    const written = JSON.parse(
      await fs.readFile(path.join(root, 'anonymous', files[0].name), 'utf8'),
    );
    expect(written.version).toBe(2);
  });

  it("serves only the requesting owner's files, by generated name only", async () => {
    const mine = await writeBackup('anonymous', JSON.stringify({ version: 2, mine: true }));
    await fs.mkdir(path.join(root, 'user-1'), { recursive: true });
    await fs.writeFile(path.join(root, 'user-1', mine.name), JSON.stringify({ theirs: true }));

    const status = await request(app).get('/api/backup').query({ owner: 'anonymous' });
    expect(status.status).toBe(200);
    expect(status.body.data.files.map((f: { name: string }) => f.name)).toEqual([mine.name]);
    expect(status.body.data.folder).toBe(path.join(root, 'anonymous'));

    const file = await request(app).get(`/api/backup/files/${mine.name}`);
    expect(file.body.data).toEqual({ version: 2, mine: true });

    for (const name of ['..%2Fuser-1%2Fx.json', 'config.json', '..%5Cconfig.json']) {
      const refused = await request(app).get(`/api/backup/files/${name}`);
      expect(refused.status).toBe(404);
    }
  });

  it('requires the admin check like restore', async () => {
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    const remote = () => request(app).get('/api/backup').set('X-Forwarded-For', '203.0.113.9');
    // Loopback without forwarding is admitted; supertest connects over loopback.
    expect((await request(app).get('/api/backup')).status).toBe(200);
    const res = await remote();
    // trust proxy is `loopback`, so the forwarded remote address is the one checked.
    expect(res.status).toBe(403);
    const exportRes = await request(app)
      .get('/api/backup/export')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(exportRes.status).toBe(403);
  });

  it('stores interval and retention changes from the admin endpoint', async () => {
    const res = await request(app).patch('/api/backup/config').send({ intervalHours: 6, keep: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ intervalHours: 6, keep: 3 });
    const status = await request(app).get('/api/backup');
    expect(status.body.data.config).toEqual({ intervalHours: 6, keep: 3 });

    const invalid = await request(app).patch('/api/backup/config').send({ keep: 0 });
    expect(invalid.status).toBe(400);
  });
});

describe('scheduler', () => {
  it('backs up each due owner into its own folder and skips recent or empty ones', async () => {
    prismaMock.user.findMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }]);
    // user-2 has nothing to back up.
    vi.mocked(mangaService.getManga).mockImplementation(
      async (_options, userId) => (userId === 'user-2' ? [] : [{ id: 'm1' }]) as never,
    );
    vi.mocked(historyService.getHistory).mockResolvedValue([] as never);
    const now = Date.parse('2026-05-01T12:00:00Z');
    // Anonymous was backed up an hour ago; with a 24h interval it is not due.
    await writeBackup('anonymous', '{}', new Date(now - 60 * 60 * 1000));

    const written = await runScheduledBackups(now);

    expect(written).toBe(1);
    expect(await listBackups('anonymous')).toHaveLength(1);
    expect(await listBackups('user-1')).toHaveLength(1);
    expect(await listBackups('user-2')).toHaveLength(0);
  });

  it('does nothing when the interval is 0', async () => {
    process.env.BACKUP_INTERVAL_HOURS = '0';
    expect(await runScheduledBackups()).toBe(0);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });
});
