import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

/** Every authenticated request in this file needs attachUser to resolve a real user —
 * same session-cookie mocking pattern as auth.test.ts. */
function mockLoggedInSession(user_id = 'user-1') {
  prismaMock.user.findUniqueOrThrow.mockResolvedValue({ sync_generation: 0 });
  prismaMock.restore_job.findFirst.mockResolvedValue(null);
  prismaMock.session.findUnique.mockResolvedValueOnce({
    id: 'sess-1',
    user_id,
    expires_at: new Date(Date.now() + 60_000),
    user: { id: user_id, email: 'reader@example.com', display_name: null, created_at: new Date() },
  });
}

describe('GET /api/sync/pull', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/sync/pull');
    expect(res.status).toBe(401);
  });

  it('returns every domain, keyed by cursor, when authenticated', async () => {
    mockLoggedInSession();
    prismaMock.user_library.findMany.mockResolvedValueOnce([{ id: 'ul-1', manga_id: 'm-1' }]);
    prismaMock.user_manga_state.findMany.mockResolvedValueOnce([]);
    prismaMock.user_chapter_state.findMany.mockResolvedValueOnce([]);
    prismaMock.user_manga_category.findMany.mockResolvedValueOnce([]);
    prismaMock.history.findMany.mockResolvedValueOnce([]);
    prismaMock.category.findMany.mockResolvedValueOnce([{ id: 'action', name: 'Action' }]);

    const res = await request(app).get('/api/sync/pull').set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(res.body.data.library).toEqual([{ id: 'ul-1', manga_id: 'm-1' }]);
    expect(res.body.data.categories).toEqual([{ id: 'action', name: 'Action' }]);
    expect(typeof res.body.data.server_time).toBe('string');
  });
});

describe('POST /api/sync/push', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/sync/push').send({});
    expect(res.status).toBe(401);
  });

  it('rejects a malformed row with 400 before touching the database', async () => {
    mockLoggedInSession();

    const res = await request(app)
      .post('/api/sync/push')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ chapter_state: [{ chapter_id: 'c-1' }] }); // missing is_read/last_page_read/updated_at

    expect(res.status).toBe(400);
    expect(prismaMock.user_chapter_state.upsert).not.toHaveBeenCalled();
  });

  it('applies a valid push and reports how many rows landed per domain', async () => {
    mockLoggedInSession();
    prismaMock.user_library.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.user_library.create.mockResolvedValueOnce({ id: 'ul-1' });

    const res = await request(app)
      .post('/api/sync/push')
      .set('Cookie', ['pm_session=sess-1'])
      .send({
        library: [{ manga_id: 'm-1', deleted_at: null, updated_at: new Date().toISOString() }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      library: { applied: 1, failed: [] },
      manga_state: { applied: 0, failed: [] },
      chapter_state: { applied: 0, failed: [] },
      manga_category: { applied: 0, failed: [] },
      history: { applied: 0, failed: [] },
    });
  });

  it('reports a bad row as failed instead of aborting the rest of the batch', async () => {
    mockLoggedInSession();
    // First library row succeeds, second fails on the write itself. Rows within a domain
    // are applied in bounded-concurrency batches, so the two outcomes are queued as
    // ordered defaults rather than tied to a specific call sequence.
    prismaMock.user_library.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.user_library.create
      .mockResolvedValueOnce({ id: 'ul-1' })
      .mockRejectedValueOnce(new Error('FK violation'));

    const res = await request(app)
      .post('/api/sync/push')
      .set('Cookie', ['pm_session=sess-1'])
      .send({
        library: [
          { manga_id: 'm-1', deleted_at: null, updated_at: new Date().toISOString() },
          { manga_id: 'm-does-not-exist', deleted_at: null, updated_at: new Date().toISOString() },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.library.applied).toBe(1);
    expect(res.body.data.library.failed).toEqual(['m-does-not-exist']);
  });
});
