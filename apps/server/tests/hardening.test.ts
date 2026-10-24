import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import sourceService from '../src/services/source.service.js';
import mangaRepository from '../src/repositories/manga.repository.js';

/**
 * Regression cover for the security and concurrency fixes, each of which is invisible to
 * a normal functional test: the thing that went wrong before was never the response body,
 * it was what got stored, how many upstream requests went out, or which rows were swept.
 */

function mockLoggedInSession(user_id = 'user-1') {
  prismaMock.session.findUnique.mockResolvedValueOnce({
    id: 'sess-hash',
    user_id,
    expires_at: new Date(Date.now() + 60_000),
    user: { id: user_id, email: 'reader@example.com', display_name: null, created_at: new Date() },
  });
}

describe('session tokens are stored hashed, never in plaintext', () => {
  it('persists a hash and puts a different value — the raw token — in the cookie', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null); // email not taken
    prismaMock.user.count.mockResolvedValueOnce(1); // not the first account: skip the claim path
    prismaMock.user.create.mockResolvedValueOnce({
      id: 'user-1',
      email: 'reader@example.com',
      display_name: null,
      created_at: new Date(),
    });
    prismaMock.session.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => data,
    );

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'reader@example.com', password: 'a-long-enough-password' });

    expect(res.status).toBe(201);

    const cookie = res.headers['set-cookie'][0];
    const rawToken = decodeURIComponent(/pm_session=([^;]+)/.exec(cookie)![1]);
    const storedId = prismaMock.session.create.mock.calls[0][0].data.id;

    // The two must differ — that difference is the entire protection.
    expect(storedId).not.toBe(rawToken);
    expect(storedId).toBe(crypto.createHash('sha256').update(rawToken).digest('hex'));
    // And the raw token must appear nowhere in what was written to the database.
    expect(JSON.stringify(prismaMock.session.create.mock.calls[0][0])).not.toContain(rawToken);
  });

  it('authenticates a request by the hash of its cookie, not the cookie itself', async () => {
    const rawToken = 'a-raw-session-token';
    prismaMock.session.findUnique.mockResolvedValueOnce(null);

    await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`pm_session=${rawToken}`]);

    expect(prismaMock.session.findUnique).toHaveBeenCalledWith({
      where: { id: crypto.createHash('sha256').update(rawToken).digest('hex') },
      include: { user: true },
    });
  });
});

describe('library update sweep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('only sweeps titles that are actually in a library, never shadow rows', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([]);

    await mangaRepository.listLibraryBasic();

    // A manga row can exist with in_library = false (a shadow row created by a download
    // or a bookmark). Sweeping those scraped sources for titles nobody had added.
    expect(prismaMock.manga.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ in_library: true }, { user_library: { some: { deleted_at: null } } }],
      },
      select: { id: true, slug: true, title: true, source: true },
    });
  });

  it('joins a running sweep instead of starting a second one', async () => {
    // Gate the sweep on its very first step so a second call arrives while the first is
    // still in flight. An empty library keeps the rest of the source machinery out of it
    // — what's under test is the guard, not the scraping.
    let releaseSweep: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });

    const listSpy = vi.spyOn(mangaRepository, 'listLibraryBasic').mockImplementation(async () => {
      await gate;
      return [] as Awaited<ReturnType<typeof mangaRepository.listLibraryBasic>>;
    });

    const first = sourceService.checkAllLibraryUpdates();
    const second = sourceService.checkAllLibraryUpdates();

    releaseSweep();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // The second caller rode along rather than launching a parallel scrape of the whole
    // library — which is what made this endpoint an amplification vector.
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(firstResult.alreadyRunning).toBe(false);
    expect(secondResult.alreadyRunning).toBe(true);
    expect(secondResult.checked).toBe(firstResult.checked);
  });

  it('starts a fresh sweep once the previous one has finished', async () => {
    vi.spyOn(mangaRepository, 'listLibraryBasic').mockResolvedValue(
      [] as Awaited<ReturnType<typeof mangaRepository.listLibraryBasic>>,
    );

    const one = await sourceService.checkAllLibraryUpdates();
    const two = await sourceService.checkAllLibraryUpdates();

    expect(one.alreadyRunning).toBe(false);
    expect(two.alreadyRunning).toBe(false);
  });
});

describe('POST /api/source/library/check-updates', () => {
  it('stays reachable without an account — the app works fully anonymously', async () => {
    vi.spyOn(mangaRepository, 'listLibraryBasic').mockResolvedValue(
      [] as Awaited<ReturnType<typeof mangaRepository.listLibraryBasic>>,
    );

    const res = await request(app).post('/api/source/library/check-updates');

    expect(res.status).toBe(200);
    vi.restoreAllMocks();
  });

  it('sets standard rate-limit headers so the ceiling is visible to callers', async () => {
    vi.spyOn(mangaRepository, 'listLibraryBasic').mockResolvedValue(
      [] as Awaited<ReturnType<typeof mangaRepository.listLibraryBasic>>,
    );

    const res = await request(app).post('/api/source/library/check-updates');

    expect(res.headers['ratelimit-limit']).toBeDefined();
    vi.restoreAllMocks();
  });
});

describe('security headers', () => {
  it('sends helmet defaults on API responses', async () => {
    mockLoggedInSession();
    const res = await request(app).get('/api/auth/me');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    // Relaxed deliberately: apps/web is a different origin and loads proxied covers.
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});
