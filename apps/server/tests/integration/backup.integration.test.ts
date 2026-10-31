import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import prisma from '../../src/configs/prisma.config.js';
import { replaceBackup } from '../../src/repositories/restore.repository.js';
import { replaceBackupBodySchema } from '@projekt-manga/schemas';
import { buildExport } from '../../src/services/backup.service.js';

const backupFor = (expectedUserId: string | null, slug: string) =>
  replaceBackupBodySchema.parse({
    jobId: randomUUID(),
    expectedUserId,
    version: 2,
    manga: [
      {
        id: `${slug}-id`,
        source: 'test-source',
        slug,
        title: slug,
        author: 'Author',
        thumbnail_url: 'https://example.com/cover.jpg',
        artist: null,
        description: 'About',
        genres: 'Action',
        status: 'ONGOING',
        rating: null,
        chapters: [
          {
            source_chapter_key: `${slug}-c1`,
            id: `${slug}-c1`,
            url: 'https://example.com/1',
            name: 'Chapter 1',
            scanlator: null,
            chapter_number: 1,
            last_page_read: 4,
            is_read: false,
            is_bookmark: true,
            release_date: '2026-01-02T00:00:00.000Z',
            page_count: 10,
          },
        ],
      },
    ],
    library: [
      {
        manga_id: `${slug}-id`,
        is_bookmarked: true,
        shelf_status: 'READING',
        notification_read: false,
      },
    ],
    history: [
      {
        source: 'test-source',
        manga_slug: slug,
        source_chapter_key: `${slug}-c1`,
        title: slug,
        read_at: '2026-02-03T00:00:00.000Z',
        last_read: '2026-02-03T00:00:00.000Z',
        last_page_read: 4,
        pages_read: 4,
      },
    ],
  });

/** What a restore will act on: the export as the restore endpoint would parse it. */
const restorable = (exported: unknown, expectedUserId: string | null) =>
  replaceBackupBodySchema.safeParse({
    ...(exported as object),
    jobId: randomUUID(),
    expectedUserId,
  });

describe('server-side export (real SQLite)', () => {
  it('round-trips an anonymous restore through the restore schema', async () => {
    await replaceBackup(backupFor(null, 'anon-title'));

    const exported = await buildExport();
    const parsed = restorable(exported, null);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(exported.settings).toBeNull();
    expect(parsed.data.manga.map((entry) => entry.slug)).toEqual(['anon-title']);
    const [chapter] = parsed.data.manga[0].chapters;
    expect(chapter).toMatchObject({
      source_chapter_key: 'anon-title-c1',
      last_page_read: 4,
      is_bookmark: true,
    });
    expect(parsed.data.library).toEqual([
      expect.objectContaining({ manga_id: parsed.data.manga[0].id, shelf_status: 'READING' }),
    ]);
    expect(parsed.data.history).toEqual([
      expect.objectContaining({ manga_slug: 'anon-title', source_chapter_key: 'anon-title-c1' }),
    ]);
  });

  it("exports only the signed-in owner's data, never anonymous or another account's", async () => {
    const user = await prisma.user.create({
      data: { email: 'backup-owner@example.com', password_hash: 'x' },
    });
    const other = await prisma.user.create({
      data: { email: 'backup-other@example.com', password_hash: 'x' },
    });
    await replaceBackup(backupFor(null, 'anon-only'));
    await replaceBackup(backupFor(user.id, 'mine'), user.id);
    await replaceBackup(backupFor(other.id, 'theirs'), other.id);

    const exported = await buildExport(user.id);
    const parsed = restorable(exported, user.id);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.manga.map((entry) => entry.slug)).toEqual(['mine']);
    expect(parsed.data.history.map((entry) => entry.manga_slug)).toEqual(['mine']);
    expect(parsed.data.manga[0].chapters[0]).toMatchObject({ last_page_read: 4 });
  });
});
