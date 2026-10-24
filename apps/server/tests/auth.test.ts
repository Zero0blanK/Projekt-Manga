import { describe, it, expect } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

describe('POST /api/auth/register', () => {
  it('creates an account and sets a session cookie', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    prismaMock.user.create.mockResolvedValueOnce({
      id: 'user-1',
      email: 'reader@example.com',
      display_name: null,
      password_hash: 'hashed',
      created_at: new Date(),
      updated_at: new Date(),
    });
    prismaMock.session.create.mockResolvedValueOnce({ id: 'sess-1' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'reader@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('reader@example.com');
    expect(res.headers['set-cookie']?.[0]).toContain('pm_session=');
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
  });

  it.each(['', '   '])(
    'accepts a blank optional display name (%j) without storing an empty string',
    async (displayName) => {
      prismaMock.user.findUnique.mockResolvedValueOnce(null);
      prismaMock.user.create.mockResolvedValueOnce({
        id: 'user-1',
        email: 'reader@example.com',
        display_name: null,
        password_hash: 'hashed',
        created_at: new Date(),
        updated_at: new Date(),
      });
      prismaMock.session.create.mockResolvedValueOnce({ id: 'sess-1' });

      const res = await request(app).post('/api/auth/register').send({
        email: 'reader@example.com',
        password: 'correct-horse-battery',
        display_name: displayName,
      });

      expect(res.status).toBe(201);
      expect(prismaMock.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ display_name: undefined }),
      });
    },
  );

  it('rejects a duplicate email with 409', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'user-1', email: 'reader@example.com' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'reader@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(409);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('rejects a password over the 72-byte bcrypt limit before touching the database', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'reader@example.com', password: 'x'.repeat(73) });

    expect(res.status).toBe(400);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a short password with 400 before touching the database', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'reader@example.com', password: 'short' });

    expect(res.status).toBe(400);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('removes the new account when taking over the existing library fails, so a retry works', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    prismaMock.user.count.mockResolvedValueOnce(0);
    prismaMock.user.create.mockResolvedValueOnce({
      id: 'user-1',
      email: 'first@example.com',
      display_name: null,
      password_hash: 'hashed',
      created_at: new Date(),
      updated_at: new Date(),
    });
    prismaMock.manga.findMany.mockRejectedValueOnce(new Error('database is locked'));
    prismaMock.user.delete.mockResolvedValueOnce({ id: 'user-1' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'first@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(500);
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(prismaMock.session.create).not.toHaveBeenCalled();
  });

  it('claims the existing anonymous library/history for the very first account on this server', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    prismaMock.user.count.mockResolvedValueOnce(0); // no accounts exist yet
    prismaMock.user.create.mockResolvedValueOnce({
      id: 'user-1',
      email: 'first@example.com',
      display_name: null,
      password_hash: 'hashed',
      created_at: new Date(),
      updated_at: new Date(),
    });
    prismaMock.session.create.mockResolvedValueOnce({ id: 'sess-1' });

    // The four sources claimExistingAnonymousData reads from.
    prismaMock.manga.findMany.mockResolvedValueOnce([{ id: 'm-1' }, { id: 'm-2' }]); // listLibraryMangaIds
    prismaMock.manga_library.findMany.mockResolvedValueOnce([
      { manga_id: 'm-1', is_bookmarked: true, shelf_status: 'READING', notification_read: false },
    ]);
    prismaMock.chapter.findMany.mockResolvedValueOnce([
      { id: 'ch-1', is_read: true, is_bookmark: false, last_page_read: 12 },
    ]);
    prismaMock.manga_category.findMany.mockResolvedValueOnce([
      { manga_id: 'm-1', category_id: 'action' },
    ]);

    prismaMock.user_library.createMany.mockResolvedValueOnce({ count: 2 });
    prismaMock.user_manga_state.createMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.user_chapter_state.createMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.user_manga_category.createMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.history.updateMany.mockResolvedValueOnce({ count: 3 });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'first@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(201);
    expect(prismaMock.user_library.createMany).toHaveBeenCalledWith({
      data: [
        { user_id: 'user-1', manga_id: 'm-1' },
        { user_id: 'user-1', manga_id: 'm-2' },
      ],
    });
    expect(prismaMock.user_chapter_state.createMany).toHaveBeenCalledWith({
      data: [
        {
          user_id: 'user-1',
          chapter_id: 'ch-1',
          is_read: true,
          is_bookmark: false,
          last_page_read: 12,
        },
      ],
    });
    expect(prismaMock.history.updateMany).toHaveBeenCalledWith({
      where: { user_id: null },
      data: { user_id: 'user-1', sync_updated_at: expect.any(Date) },
    });
  });

  it('does not claim anonymous data for the second account', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    prismaMock.user.count.mockResolvedValueOnce(1); // an account already exists
    prismaMock.user.create.mockResolvedValueOnce({
      id: 'user-2',
      email: 'second@example.com',
      display_name: null,
      password_hash: 'hashed',
      created_at: new Date(),
      updated_at: new Date(),
    });
    prismaMock.session.create.mockResolvedValueOnce({ id: 'sess-2' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'second@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(201);
    expect(prismaMock.user_library.createMany).not.toHaveBeenCalled();
    expect(prismaMock.history.updateMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with a correct password and sets a session cookie', async () => {
    const password_hash = await bcrypt.hash('correct-horse-battery', 4);
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      email: 'reader@example.com',
      display_name: null,
      password_hash,
      created_at: new Date(),
      updated_at: new Date(),
    });
    prismaMock.session.create.mockResolvedValueOnce({ id: 'sess-1' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reader@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe('user-1');
    expect(res.headers['set-cookie']?.[0]).toContain('pm_session=');
  });

  it('rejects an unknown email with 401, without leaking whether the account exists', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever12345' });

    expect(res.status).toBe(401);
    expect(res.body.message).not.toMatch(/exist|found/i);
  });

  it('rejects a wrong password with 401', async () => {
    const password_hash = await bcrypt.hash('the-real-password', 4);
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      email: 'reader@example.com',
      password_hash,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reader@example.com', password: 'a-wrong-password' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns { user: null } with a 200, not a 401, when unauthenticated', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(res.body.data.user).toBeNull();
  });

  it('returns the current user when a valid session cookie is sent', async () => {
    prismaMock.session.findUnique.mockResolvedValueOnce({
      id: 'sess-1',
      user_id: 'user-1',
      expires_at: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1',
        email: 'reader@example.com',
        display_name: 'Reader',
        created_at: new Date(),
      },
    });

    const res = await request(app).get('/api/auth/me').set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('reader@example.com');
  });

  it('treats an expired session as unauthenticated, and clears it out', async () => {
    prismaMock.session.findUnique.mockResolvedValueOnce({
      id: 'sess-1',
      user_id: 'user-1',
      expires_at: new Date(Date.now() - 60_000),
      user: {
        id: 'user-1',
        email: 'reader@example.com',
        display_name: null,
        created_at: new Date(),
      },
    });
    prismaMock.session.delete.mockResolvedValueOnce({ id: 'sess-1' });

    const res = await request(app).get('/api/auth/me').set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(res.body.data.user).toBeNull();
    // Expiry used to be checked but never acted on, so lapsed rows accumulated for the life
    // of the install. An expired session can't authenticate anything, so it goes.
    expect(prismaMock.session.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess-1' } }),
    );
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    prismaMock.session.delete.mockResolvedValueOnce({ id: 'sess-1' });

    const res = await request(app).post('/api/auth/logout').set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/pm_session=;/);
  });
});

describe('POST /api/auth/sessions/revoke-others', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/auth/sessions/revoke-others');
    expect(res.status).toBe(401);
  });

  it('revokes every other session for the account and reports how many', async () => {
    prismaMock.session.findUnique.mockResolvedValueOnce({
      id: 'sess-current',
      user_id: 'user-1',
      expires_at: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1',
        email: 'reader@example.com',
        display_name: null,
        created_at: new Date(),
      },
    });
    prismaMock.session.deleteMany.mockResolvedValueOnce({ count: 2 });

    const res = await request(app)
      .post('/api/auth/sessions/revoke-others')
      .set('Cookie', ['pm_session=sess-current']);

    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(2);
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', id: { not: 'sess-current' } },
    });
  });
});

describe('DELETE /api/auth/me', () => {
  it('requires authentication', async () => {
    const res = await request(app).delete('/api/auth/me');
    expect(res.status).toBe(401);
  });

  const signedIn = () =>
    prismaMock.session.findUnique.mockResolvedValueOnce({
      id: 'sess-1',
      user_id: 'user-1',
      expires_at: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1',
        email: 'reader@example.com',
        display_name: null,
        created_at: new Date(),
      },
    });

  it('deletes the account when the password is confirmed', async () => {
    signedIn();
    const password_hash = await bcrypt.hash('the-real-password', 4);
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'user-1', password_hash });
    prismaMock.user.delete.mockResolvedValueOnce({ id: 'user-1' });

    const res = await request(app)
      .delete('/api/auth/me')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ password: 'the-real-password' });

    expect(res.status).toBe(200);
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
  });

  it('keeps the account when the password is wrong or missing', async () => {
    signedIn();
    const password_hash = await bcrypt.hash('the-real-password', 4);
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'user-1', password_hash });
    const wrong = await request(app)
      .delete('/api/auth/me')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ password: 'a-guess' });
    expect(wrong.status).toBe(401);

    signedIn();
    const missing = await request(app).delete('/api/auth/me').set('Cookie', ['pm_session=sess-1']);
    expect(missing.status).toBe(400);
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });
});
