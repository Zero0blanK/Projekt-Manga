import { describe, expect, it } from 'vitest';
import prisma from '../../src/configs/prisma.config.js';
import syncService from '../../src/services/sync.service.js';
import historyRepository from '../../src/repositories/history.repository.js';

describe('history sync paging (real SQLite)', () => {
  it('merges conflicting chapter progress monotonically within each account', async () => {
    const user = await prisma.user.create({
      data: { email: 'sync-conflict@example.test', password_hash: 'fixture-only' },
    });
    const secondUser = await prisma.user.create({
      data: { email: 'sync-conflict-second@example.test', password_hash: 'fixture-only' },
    });
    const manga = await prisma.manga.create({
      data: {
        source: 'sync-fixture',
        slug: 'conflict-title',
        title: 'Conflict title',
        author: 'Fixture author',
        thumbnail_url: '',
        in_library: false,
      },
    });
    const chapter = await prisma.chapter.create({
      data: {
        id: 'sync-conflict-chapter',
        manga_id: manga.id,
        url: 'https://example.test/chapter',
        chapter_number: 1,
      },
    });
    await prisma.user_chapter_state.create({
      data: {
        user_id: user.id,
        chapter_id: chapter.id,
        is_read: false,
        is_bookmark: true,
        last_page_read: 4,
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    await syncService.push(user.id, {
      generation: 0,
      chapter_state: [
        {
          chapter_id: chapter.id,
          is_read: true,
          is_bookmark: false,
          last_page_read: 2,
          updated_at: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    await syncService.push(user.id, {
      generation: 0,
      chapter_state: [
        {
          chapter_id: chapter.id,
          is_read: false,
          is_bookmark: false,
          last_page_read: 9,
          updated_at: '2027-01-01T00:00:00.000Z',
        },
      ],
    });
    await syncService.push(secondUser.id, {
      generation: 0,
      chapter_state: [
        {
          chapter_id: chapter.id,
          is_read: false,
          is_bookmark: false,
          last_page_read: 1,
          updated_at: '2027-02-01T00:00:00.000Z',
        },
      ],
    });

    await expect(
      prisma.user_chapter_state.findUniqueOrThrow({
        where: { user_id_chapter_id: { user_id: user.id, chapter_id: chapter.id } },
      }),
    ).resolves.toMatchObject({ is_read: true, is_bookmark: false, last_page_read: 9 });
    await expect(
      prisma.user_chapter_state.findUniqueOrThrow({
        where: { user_id_chapter_id: { user_id: secondUser.id, chapter_id: chapter.id } },
      }),
    ).resolves.toMatchObject({ is_read: false, is_bookmark: false, last_page_read: 1 });
  });

  it('advances through a page boundary of rows with identical timestamps', async () => {
    const user = await prisma.user.create({
      data: { email: 'sync-cursor@example.test', password_hash: 'fixture-only' },
    });
    const at = new Date('2026-01-01T00:00:00.000Z');
    await prisma.history.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        id: `history-${String(index).padStart(3, '0')}`,
        user_id: user.id,
        source: 'fixture',
        manga_slug: 'fixture',
        read_at: at,
        last_read: at,
        sync_updated_at: at,
      })),
    });

    const first = await syncService.pull(user.id);
    expect(first.history).toHaveLength(500);
    expect(first.has_more).toBe(true);

    const second = await syncService.pull(user.id, first.next_since);
    expect(second.history.map((row) => row.id)).toEqual(['history-500']);
    expect(second.has_more).toBe(false);
  });

  it('includes a deleted history row in the next delta', async () => {
    const user = await prisma.user.create({
      data: { email: 'sync-delete@example.test', password_hash: 'fixture-only' },
    });
    const at = new Date('2026-01-01T00:00:00.000Z');
    await prisma.history.create({
      data: {
        id: 'delete-me',
        user_id: user.id,
        source: 'fixture',
        manga_slug: 'fixture',
        read_at: at,
        last_read: at,
        sync_updated_at: at,
      },
    });
    const before = await syncService.pull(user.id);

    await historyRepository.softDeleteHistory('delete-me', user.id);
    const after = await syncService.pull(user.id, before.next_since);

    expect(after.history).toHaveLength(1);
    expect(after.history[0].deleted_at).not.toBeNull();
    expect(after.history[0].last_read.getTime()).toBeGreaterThanOrEqual(
      new Date(before.next_since).getTime(),
    );
  });

  it('pulls an incoming read whose client last_read predates the previous cursor', async () => {
    const user = await prisma.user.create({
      data: { email: 'sync-backdated@example.test', password_hash: 'fixture-only' },
    });
    const before = await syncService.pull(user.id);
    const oldRead = new Date('2020-01-01T00:00:00.000Z');
    await historyRepository.applyIncoming(user.id, {
      id: 'backdated-read',
      source: 'fixture',
      manga_id: null,
      manga_slug: 'fixture',
      title: null,
      thumbnail_url: null,
      chapter_id: null,
      read_at: oldRead,
      last_read: oldRead,
      pages_read: 1,
      time_read: 0,
      deleted_at: null,
    });

    const after = await syncService.pull(user.id, before.next_since);
    expect(after.history.map((row) => row.id)).toContain('backdated-read');
  });

  it('does not create duplicate rows for simultaneous reads of one chapter', async () => {
    const user = await prisma.user.create({
      data: { email: 'sync-concurrent@example.test', password_hash: 'fixture-only' },
    });
    const read = { source: 'fixture', manga_slug: 'same-manga', pages_read: 1, time_read: 10 };

    await Promise.all([
      historyRepository.addHistory(read, user.id),
      historyRepository.addHistory(read, user.id),
    ]);

    const rows = await prisma.history.findMany({
      where: { user_id: user.id, manga_slug: 'same-manga' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].time_read).toBe(20);
  });

  // Last-write-wins compares when each device made its edit, not when the server received
  // it: an edit made earlier but synced later must not overwrite a newer one.
  it('keeps the newer edit when an older one arrives later', async () => {
    const user = await prisma.user.create({
      data: { email: 'sync-late-arrival@example.test', password_hash: 'fixture-only' },
    });
    const manga = await prisma.manga.create({
      data: {
        source: 'sync-fixture',
        slug: 'late-arrival-title',
        title: 'Late arrival',
        author: 'Fixture author',
        thumbnail_url: '',
        in_library: false,
      },
    });
    const push = (shelf_status: 'READING' | 'COMPLETED', updated_at: string) =>
      syncService.push(user.id, {
        generation: 0,
        manga_state: [
          {
            manga_id: manga.id,
            is_bookmarked: false,
            shelf_status,
            notification_read: false,
            updated_at,
          },
        ],
      });

    // Device B edits at 11:00 and syncs at once; device A's 09:00 edit syncs afterwards.
    await push('COMPLETED', '2026-03-01T11:00:00.000Z');
    await push('READING', '2026-03-01T09:00:00.000Z');

    const row = await prisma.user_manga_state.findUniqueOrThrow({
      where: { user_id_manga_id: { user_id: user.id, manga_id: manga.id } },
    });
    expect(row.shelf_status).toBe('COMPLETED');
    expect(row.edited_at?.toISOString()).toBe('2026-03-01T11:00:00.000Z');

    // A direct edit on the server afterwards is newer than both and clears the device time.
    await prisma.user_manga_state.update({
      where: { id: row.id },
      data: { shelf_status: 'ON_HOLD', edited_at: null },
    });
    await push('READING', '2026-03-01T12:00:00.000Z');
    const after = await prisma.user_manga_state.findUniqueOrThrow({ where: { id: row.id } });
    // 12:00 in 2026 is long before this test runs, so the direct edit wins.
    expect(after.shelf_status).toBe('ON_HOLD');

    const pulled = await syncService.pull(user.id);
    expect(pulled.manga_state.find((r) => r.manga_id === manga.id)).toMatchObject({
      shelf_status: 'ON_HOLD',
      edited_at: null,
    });
  });
});
