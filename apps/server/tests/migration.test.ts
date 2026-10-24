import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import migrationService from '../src/services/migration.service.js';

/**
 * Migration is the one operation here that moves a reader's accumulated state between two
 * rows, so the two things worth pinning down are that it moves the *right* state for the
 * path it's on — overlay tables for an account, shared tables anonymously — and that it
 * cannot land halfway.
 */

function mockLoggedInSession(user_id = 'user-1') {
  prismaMock.session.findUnique.mockResolvedValueOnce({
    id: 'sess-hash',
    user_id,
    expires_at: new Date(Date.now() + 60_000),
    user: { id: user_id, email: 'reader@example.com', display_name: null, created_at: new Date() },
  });
}

/** Both manga rows exist — the guard the service runs inside the transaction. */
function mockBothMangaExist() {
  prismaMock.manga.findUnique
    .mockResolvedValueOnce({ id: 'old-1' })
    .mockResolvedValueOnce({ id: 'new-1' });
}

beforeEach(() => {
  prismaMock.manga.update.mockResolvedValue({});
  prismaMock.manga_library.upsert.mockResolvedValue({});
  prismaMock.user_manga_state.upsert.mockResolvedValue({});
  prismaMock.user_library.upsert.mockResolvedValue({});
  prismaMock.chapter.findMany.mockResolvedValue([]);
  prismaMock.user_chapter_state.findMany.mockResolvedValue([]);
  prismaMock.manga_library.findUnique.mockResolvedValue(null);
  prismaMock.user_manga_state.findUnique.mockResolvedValue(null);
  prismaMock.manga_category.findMany.mockResolvedValue([]);
  prismaMock.user_manga_category.findMany.mockResolvedValue([]);
});

describe('POST /api/manga/:manga_id/migrate', () => {
  it('stays reachable without an account — migration is not an account feature', async () => {
    mockBothMangaExist();

    const res = await request(app).post('/api/manga/old-1/migrate').send({ to_manga_id: 'new-1' });

    expect(res.status).toBe(200);
  });

  it('rejects a body with no destination before touching the database', async () => {
    const res = await request(app).post('/api/manga/old-1/migrate').send({});

    expect(res.status).toBe(400);
    expect(prismaMock.manga.findUnique).not.toHaveBeenCalled();
  });

  it('refuses to migrate a title onto itself', async () => {
    const res = await request(app).post('/api/manga/old-1/migrate').send({ to_manga_id: 'old-1' });

    expect(res.status).toBe(400);
  });

  it('404s when either title has gone', async () => {
    prismaMock.manga.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'new-1' });

    const res = await request(app).post('/api/manga/old-1/migrate').send({ to_manga_id: 'new-1' });

    expect(res.status).toBe(404);
  });
});

describe('migration — anonymous path', () => {
  it('carries progress across by chapter number and marks them on the shared rows', async () => {
    mockBothMangaExist();
    // Read chapters on the old entry: furthest is 3.
    prismaMock.chapter.findMany
      .mockResolvedValueOnce([{ chapter_number: 1 }, { chapter_number: 3 }])
      .mockResolvedValueOnce([{ id: 'n-1' }, { id: 'n-2' }, { id: 'n-3' }]);
    prismaMock.chapter.updateMany.mockResolvedValueOnce({ count: 3 });

    const summary = await migrationService.migrateManga('old-1', 'new-1', {
      removeOld: true,
      moveHistory: false,
    });

    expect(summary.progress).toBe(3);
    // Only chapters at or below the furthest read, looked up on the *new* entry.
    expect(prismaMock.chapter.findMany).toHaveBeenLastCalledWith({
      where: { manga_id: 'new-1', chapter_number: { lte: 3 } },
      select: { id: true },
    });
    expect(summary.chapters_marked).toBe(3);
  });

  it('writes shared tables and never the per-account overlay ones', async () => {
    mockBothMangaExist();
    prismaMock.manga_library.findUnique.mockResolvedValueOnce({
      is_bookmarked: true,
      shelf_status: 'READING',
      notification_read: false,
    });

    const summary = await migrationService.migrateManga('old-1', 'new-1', {
      removeOld: true,
      moveHistory: false,
    });

    expect(summary.state_copied).toBe(true);
    expect(prismaMock.manga_library.upsert).toHaveBeenCalled();
    expect(prismaMock.user_manga_state.upsert).not.toHaveBeenCalled();
    expect(prismaMock.user_library.upsert).not.toHaveBeenCalled();
  });

  it('takes the old entry out of the library and puts the new one in', async () => {
    mockBothMangaExist();

    const summary = await migrationService.migrateManga('old-1', 'new-1', {
      removeOld: true,
      moveHistory: false,
    });

    expect(prismaMock.manga.update).toHaveBeenCalledWith({
      where: { id: 'new-1' },
      data: { in_library: true },
    });
    expect(prismaMock.manga.update).toHaveBeenCalledWith({
      where: { id: 'old-1' },
      data: { in_library: false },
    });
    expect(summary.old_entry_removed).toBe(true);
  });

  it('leaves the old entry in place when asked to keep it', async () => {
    mockBothMangaExist();

    const summary = await migrationService.migrateManga('old-1', 'new-1', {
      removeOld: false,
      moveHistory: false,
    });

    expect(prismaMock.manga.update).not.toHaveBeenCalledWith({
      where: { id: 'old-1' },
      data: { in_library: false },
    });
    expect(summary.old_entry_removed).toBe(false);
  });

  it('re-points only the anonymous history rows, leaving accounts’ rows alone', async () => {
    mockBothMangaExist();
    prismaMock.history.updateMany.mockResolvedValueOnce({ count: 7 });

    const summary = await migrationService.migrateManga('old-1', 'new-1', {
      removeOld: true,
      moveHistory: true,
    });

    // user_id: null is what keeps one account's history out of the anonymous migration.
    expect(prismaMock.history.updateMany).toHaveBeenCalledWith({
      where: { manga_id: 'old-1', user_id: null },
      data: { manga_id: 'new-1', sync_updated_at: expect.any(Date) },
    });
    expect(summary.history_moved).toBe(7);
  });

  it('does not touch history when asked not to', async () => {
    mockBothMangaExist();

    const summary = await migrationService.migrateManga('old-1', 'new-1', {
      removeOld: true,
      moveHistory: false,
    });

    expect(prismaMock.history.updateMany).not.toHaveBeenCalled();
    expect(summary.history_moved).toBe(0);
  });
});

describe('migration — account path', () => {
  it('writes the overlay tables and never the shared ones', async () => {
    mockLoggedInSession();
    mockBothMangaExist();
    prismaMock.user_manga_state.findUnique.mockResolvedValueOnce({
      is_bookmarked: true,
      shelf_status: 'READING',
      score: 80,
      notification_read: false,
    });

    const res = await request(app)
      .post('/api/manga/old-1/migrate')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ to_manga_id: 'new-1' });

    expect(res.status).toBe(200);
    expect(res.body.data.state_copied).toBe(true);
    expect(prismaMock.user_manga_state.upsert).toHaveBeenCalled();
    // The shared rows are another account's — and the anonymous — view of these titles.
    expect(prismaMock.manga_library.upsert).not.toHaveBeenCalled();
    expect(prismaMock.manga.update).not.toHaveBeenCalledWith({
      where: { id: 'old-1' },
      data: { in_library: false },
    });
  });

  it('carries the rating across, which the anonymous path has no column for', async () => {
    mockLoggedInSession();
    mockBothMangaExist();
    prismaMock.user_manga_state.findUnique.mockResolvedValueOnce({
      is_bookmarked: false,
      shelf_status: 'PLAN',
      score: 65,
      notification_read: false,
    });

    await request(app)
      .post('/api/manga/old-1/migrate')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ to_manga_id: 'new-1' });

    expect(prismaMock.user_manga_state.upsert.mock.calls[0][0].create).toMatchObject({ score: 65 });
  });

  it('tombstones the old category tags rather than deleting them, so sync can see it', async () => {
    mockLoggedInSession();
    mockBothMangaExist();
    prismaMock.user_manga_category.findMany.mockResolvedValueOnce([{ category_id: 'cat-1' }]);

    await request(app)
      .post('/api/manga/old-1/migrate')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ to_manga_id: 'new-1' });

    expect(prismaMock.user_manga_category.createMany).toHaveBeenCalled();
    const tombstone = prismaMock.user_manga_category.updateMany.mock.calls.find(
      (c: [{ where: { manga_id: string } }]) => c[0].where.manga_id === 'old-1',
    );
    expect(tombstone?.[0].data.deleted_at).toBeInstanceOf(Date);
  });

  it('scopes the history move to this account', async () => {
    mockLoggedInSession();
    mockBothMangaExist();
    prismaMock.history.updateMany.mockResolvedValueOnce({ count: 2 });

    await request(app)
      .post('/api/manga/old-1/migrate')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ to_manga_id: 'new-1' });

    expect(prismaMock.history.updateMany).toHaveBeenCalledWith({
      where: { manga_id: 'old-1', user_id: 'user-1' },
      data: { manga_id: 'new-1', sync_updated_at: expect.any(Date) },
    });
  });
});

describe('migration atomicity', () => {
  it('runs entirely inside one transaction', async () => {
    mockBothMangaExist();

    await migrationService.migrateManga('old-1', 'new-1', {
      removeOld: true,
      moveHistory: true,
    });

    // The whole point of moving this off the client: five separate requests could leave a
    // title half-migrated, one transaction cannot.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('propagates a mid-migration failure instead of reporting partial success', async () => {
    mockBothMangaExist();
    prismaMock.manga_library.findUnique.mockResolvedValueOnce({
      is_bookmarked: true,
      shelf_status: 'READING',
      notification_read: false,
    });
    prismaMock.manga_library.upsert.mockRejectedValueOnce(new Error('deadlock'));

    await expect(
      migrationService.migrateManga('old-1', 'new-1', { removeOld: true, moveHistory: true }),
    ).rejects.toThrow('deadlock');

    // The transaction rolls back, so the old entry is never retired on a failed run.
    expect(prismaMock.manga.update).not.toHaveBeenCalledWith({
      where: { id: 'old-1' },
      data: { in_library: false },
    });
  });
});
