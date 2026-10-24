import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import { encryptToken, decryptToken } from '../src/utils/tokenCrypto.js';
import trackerService from '../src/services/tracker.service.js';
import chapterService from '../src/services/chapter.service.js';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import axios from 'axios';

function mockLoggedInSession(user_id = 'user-1') {
  prismaMock.session.findUnique.mockResolvedValueOnce({
    id: 'sess-1',
    user_id,
    expires_at: new Date(Date.now() + 60_000),
    user: { id: user_id, email: 'reader@example.com', display_name: null, created_at: new Date() },
  });
}

const TEST_KEY = 'x8ZQq0e0mJ0v3s5b0m2M3RG2b1V2wYFhFq0O7wq0O9E='; // 32 real random bytes, base64

beforeEach(() => {
  process.env.TRACKER_LINK_SPACING_MS = '0'; // the real 1.5s pacing is dead time in tests
  process.env.ANILIST_CLIENT_ID = 'test-client-id';
  process.env.ANILIST_CLIENT_SECRET = 'test-client-secret';
  process.env.ANILIST_REDIRECT_URI = 'http://localhost:4000/api/trackers/anilist/callback';
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  delete process.env.TRACKER_LINK_SPACING_MS;
  delete process.env.TRACKER_MAX_LINKS_PER_CYCLE;
  vi.mocked(axios.get).mockReset();
  vi.mocked(axios.post).mockReset();
  vi.mocked(axios.patch).mockReset();
  delete process.env.ANILIST_CLIENT_ID;
  delete process.env.ANILIST_CLIENT_SECRET;
  delete process.env.ANILIST_REDIRECT_URI;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe('tokenCrypto', () => {
  it('round-trips a plaintext value through encrypt/decrypt', () => {
    const encrypted = encryptToken('a-real-looking-access-token');
    expect(encrypted).not.toContain('a-real-looking-access-token');
    expect(decryptToken(encrypted)).toBe('a-real-looking-access-token');
  });

  it('fails closed when TOKEN_ENCRYPTION_KEY is not set', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken('x')).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});

describe('GET /api/trackers', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/trackers');
    expect(res.status).toBe(401);
  });

  it('never returns access_token/refresh_token, even encrypted', async () => {
    mockLoggedInSession();
    prismaMock.tracker_account.findMany.mockResolvedValueOnce([
      {
        id: 'ta-1',
        user_id: 'user-1',
        tracker: 'ANILIST',
        access_token: encryptToken('secret-token'),
        refresh_token: null,
        expires_at: null,
        tracker_user_id: '123',
        tracker_username: 'reader',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const res = await request(app).get('/api/trackers').set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { tracker: 'ANILIST', tracker_username: 'reader', connected_at: expect.any(String) },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
  });
});

describe('GET /api/trackers/:tracker/authorize', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/trackers/anilist/authorize');
    expect(res.status).toBe(401);
  });

  it('returns a real AniList authorize URL with a fresh state', async () => {
    mockLoggedInSession();

    const res = await request(app)
      .get('/api/trackers/anilist/authorize')
      .set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    const url = new URL(res.body.data.url);
    expect(url.origin + url.pathname).toBe('https://anilist.co/api/v2/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/api/trackers/anilist/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBeTruthy();
  });
});

describe('GET /api/trackers/:tracker/callback', () => {
  it('redirects to a not-signed-in error when there is no session', async () => {
    const res = await request(app).get('/api/trackers/anilist/callback?code=abc&state=xyz');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('tracker_error=');
  });

  it('redirects with an error when the state is invalid (CSRF protection)', async () => {
    mockLoggedInSession();

    const res = await request(app)
      .get('/api/trackers/anilist/callback?code=abc&state=never-issued')
      .set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('tracker_error=');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('exchanges a valid code+state, encrypts the tokens, and redirects to success', async () => {
    mockLoggedInSession();
    const authRes = await request(app)
      .get('/api/trackers/anilist/authorize')
      .set('Cookie', ['pm_session=sess-1']);
    const state = new URL(authRes.body.data.url).searchParams.get('state')!;

    vi.mocked(axios.post).mockResolvedValueOnce({
      data: {
        access_token: 'real-access-token',
        refresh_token: 'real-refresh-token',
        expires_in: 3600,
      },
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { Viewer: { id: 42, name: 'AniListUser' } } },
    });
    prismaMock.tracker_account.upsert.mockResolvedValueOnce({ id: 'ta-1' });

    mockLoggedInSession();
    const res = await request(app)
      .get(`/api/trackers/anilist/callback?code=real-code&state=${encodeURIComponent(state)}`)
      .set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('tracker_connected=anilist');

    const upsertCall = prismaMock.tracker_account.upsert.mock.calls[0][0] as {
      create: { access_token: string; refresh_token: string };
    };
    expect(decryptToken(upsertCall.create.access_token)).toBe('real-access-token');
    expect(decryptToken(upsertCall.create.refresh_token)).toBe('real-refresh-token');
  });

  it('cannot be replayed — the same state cannot be consumed twice', async () => {
    mockLoggedInSession();
    const authRes = await request(app)
      .get('/api/trackers/anilist/authorize')
      .set('Cookie', ['pm_session=sess-1']);
    const state = new URL(authRes.body.data.url).searchParams.get('state')!;

    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { access_token: 'tok', refresh_token: null, expires_in: 3600 },
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { Viewer: { id: 1, name: 'u' } } },
    });
    prismaMock.tracker_account.upsert.mockResolvedValueOnce({ id: 'ta-1' });

    mockLoggedInSession();
    const first = await request(app)
      .get(`/api/trackers/anilist/callback?code=c1&state=${encodeURIComponent(state)}`)
      .set('Cookie', ['pm_session=sess-1']);
    expect(first.headers.location).toContain('tracker_connected=anilist');

    mockLoggedInSession();
    const second = await request(app)
      .get(`/api/trackers/anilist/callback?code=c2&state=${encodeURIComponent(state)}`)
      .set('Cookie', ['pm_session=sess-1']);
    expect(second.headers.location).toContain('tracker_error=');
  });
});

describe('DELETE /api/trackers/:tracker', () => {
  it('requires authentication', async () => {
    const res = await request(app).delete('/api/trackers/anilist');
    expect(res.status).toBe(401);
  });

  it('removes the account and any of its manga links', async () => {
    mockLoggedInSession();
    prismaMock.tracker_account.deleteMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.tracker_link.deleteMany.mockResolvedValueOnce({ count: 2 });

    const res = await request(app)
      .delete('/api/trackers/anilist')
      .set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(prismaMock.tracker_account.deleteMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', tracker: 'ANILIST' },
    });
    expect(prismaMock.tracker_link.deleteMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', tracker: 'ANILIST' },
    });
  });
});

describe('GET /api/manga/:manga_id/tracker-link', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/manga/m-1/tracker-link');
    expect(res.status).toBe(401);
  });

  it("returns this user's links for the manga only", async () => {
    mockLoggedInSession();
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
        sync_enabled: true,
        last_synced_at: null,
      },
    ]);

    const res = await request(app)
      .get('/api/manga/m-1/tracker-link')
      .set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        id: 'link-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
      }),
    ]);
    expect(prismaMock.tracker_link.findMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', manga_id: 'm-1' },
    });
  });
});

describe('POST /api/manga/:manga_id/tracker-link', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/manga/m-1/tracker-link')
      .send({ tracker: 'ANILIST', tracker_media_id: '1' });
    expect(res.status).toBe(401);
  });

  it('401s when the tracker is not connected', async () => {
    mockLoggedInSession();
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/manga/m-1/tracker-link')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ tracker: 'ANILIST', tracker_media_id: '999' });

    expect(res.status).toBe(401);
  });

  it("seeds local progress from the tracker's remote progress when the tracker is further ahead (monotonic pull)", async () => {
    mockLoggedInSession();
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      id: 'ta-1',
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { Media: { mediaListEntry: { status: 'CURRENT', progress: 5, score: 8 } } } },
    });
    prismaMock.tracker_link.upsert.mockResolvedValueOnce({ id: 'link-1' });
    // computeLocalProgress: no chapters read locally yet.
    prismaMock.chapter.findMany.mockResolvedValueOnce([
      { id: 'c1', chapter_number: 1 },
      { id: 'c2', chapter_number: 2 },
      { id: 'c3', chapter_number: 3 },
      { id: 'c4', chapter_number: 4 },
      { id: 'c5', chapter_number: 5 },
    ]);
    prismaMock.user_chapter_state.findMany.mockResolvedValueOnce([]); // nothing read locally
    // applyRemoteProgressLocally re-fetches the chapter list.
    prismaMock.chapter.findMany.mockResolvedValueOnce([
      { id: 'c1', chapter_number: 1 },
      { id: 'c2', chapter_number: 2 },
      { id: 'c3', chapter_number: 3 },
      { id: 'c4', chapter_number: 4 },
      { id: 'c5', chapter_number: 5 },
    ]);
    prismaMock.user_chapter_state.upsert.mockResolvedValue({});

    const res = await request(app)
      .post('/api/manga/m-1/tracker-link')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ tracker: 'ANILIST', tracker_media_id: '777' });

    expect(res.status).toBe(201);
    // Chapters 1-5 all marked read locally, seeded from the tracker's progress:5.
    // Seeded as one createMany + one updateMany for the whole range, rather than an
    // upsert per chapter — see userChapterStateRepository.markManyRead.
    expect(prismaMock.user_chapter_state.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([expect.objectContaining({ user_id: 'user-1', is_read: true })]),
    });
    expect(prismaMock.user_chapter_state.createMany.mock.calls[0][0].data).toHaveLength(5);
  });
});

describe('trackerService.pollExternalChanges', () => {
  it('advances local progress when the tracker is ahead, and pushes local progress up when it is behind', async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
        sync_enabled: true,
        last_synced_at: null,
      },
      {
        id: 'link-2',
        user_id: 'user-2',
        manga_id: 'm-2',
        tracker: 'ANILIST',
        tracker_media_id: '888',
        sync_enabled: true,
        last_synced_at: null,
      },
    ]);

    // link-1: remote (progress 10) ahead of local (progress 3) — should advance locally.
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok-1'),
      expires_at: null,
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { Media: { mediaListEntry: { status: 'CURRENT', progress: 10, score: 0 } } } },
    });
    const chaptersLink1 = Array.from({ length: 10 }, (_, i) => ({
      id: `l1-c${i + 1}`,
      chapter_number: i + 1,
    }));
    prismaMock.chapter.findMany.mockResolvedValueOnce(chaptersLink1); // computeLocalProgress
    prismaMock.user_chapter_state.findMany.mockResolvedValueOnce(
      chaptersLink1.slice(0, 3).map((c) => ({ chapter_id: c.id, is_read: true })),
    );
    prismaMock.chapter.findMany.mockResolvedValueOnce(chaptersLink1); // applyRemoteProgressLocally
    // markManyRead asks which of these already have a state row before inserting (it
    // replaced createMany's skipDuplicates, which SQLite doesn't support). None do.
    prismaMock.user_chapter_state.findMany.mockResolvedValueOnce([]);
    prismaMock.user_chapter_state.upsert.mockResolvedValue({});

    // link-2: remote (progress 2) behind local (progress 7) — local must never regress,
    // and the gap must be pushed up rather than silently left behind.
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok-2'),
      expires_at: null,
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { Media: { mediaListEntry: { status: 'CURRENT', progress: 2, score: 0 } } } },
    });
    const chaptersLink2 = Array.from({ length: 7 }, (_, i) => ({
      id: `l2-c${i + 1}`,
      chapter_number: i + 1,
    }));
    prismaMock.chapter.findMany.mockResolvedValueOnce(chaptersLink2); // computeLocalProgress
    prismaMock.user_chapter_state.findMany.mockResolvedValueOnce(
      chaptersLink2.map((c) => ({ chapter_id: c.id, is_read: true })), // all 7 already read locally
    );
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { SaveMediaListEntry: { id: 1 } } },
    });

    prismaMock.tracker_link.update.mockResolvedValue({});

    const result = await trackerService.pollExternalChanges();

    expect(result.checked).toBe(2);
    expect(result.updated).toBe(2);
    // link-1 seeded chapters 1..10 in one batch; link-2 must not have triggered a
    // single local write.
    expect(prismaMock.user_chapter_state.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.user_chapter_state.createMany.mock.calls[0][0].data).toHaveLength(10);

    // The third GraphQL call is link-2's push: the local count (7), not the remote 2.
    const pushCall = vi.mocked(axios.post).mock.calls[2];
    expect(pushCall[1]).toMatchObject({ variables: { mediaId: 888, progress: 7 } });
    expect(String((pushCall[1] as { query: string }).query)).toContain('SaveMediaListEntry');
  });

  it('pushes local progress when the tracker has no list entry for the media at all', async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '999',
        sync_enabled: true,
        last_synced_at: null,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { Media: { mediaListEntry: null } } },
    });

    const chapters = Array.from({ length: 4 }, (_, i) => ({
      id: `c${i + 1}`,
      chapter_number: i + 1,
    }));
    prismaMock.chapter.findMany.mockResolvedValueOnce(chapters);
    prismaMock.user_chapter_state.findMany.mockResolvedValueOnce(
      chapters.map((c) => ({ chapter_id: c.id, is_read: true })),
    );
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { SaveMediaListEntry: { id: 1 } } },
    });
    prismaMock.tracker_link.update.mockResolvedValue({});

    const result = await trackerService.pollExternalChanges();

    expect(result.updated).toBe(1);
    expect(vi.mocked(axios.post).mock.calls[1][1]).toMatchObject({
      variables: { mediaId: 999, progress: 4 },
    });
  });

  it('syncs least-recently-synced links first and stops at the per-cycle cap', async () => {
    process.env.TRACKER_MAX_LINKS_PER_CYCLE = '1';
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'fresh',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '111',
        sync_enabled: true,
        last_synced_at: new Date('2026-08-28T00:00:00Z'),
      },
      {
        id: 'stale',
        user_id: 'user-1',
        manga_id: 'm-2',
        tracker: 'ANILIST',
        tracker_media_id: '222',
        sync_enabled: true,
        last_synced_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { Media: { mediaListEntry: { status: 'CURRENT', progress: 0, score: 0 } } } },
    });
    prismaMock.chapter.findMany.mockResolvedValueOnce([]);
    prismaMock.tracker_link.update.mockResolvedValue({});

    const result = await trackerService.pollExternalChanges();

    expect(result.checked).toBe(1);
    // The stale link, not the one synced this morning — and its media id, not the other.
    expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ variables: { id: 222 } });
    expect(prismaMock.tracker_link.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'stale' } }),
    );
  });

  it('stops the cycle as soon as a tracker rate-limits, leaving the rest for next time', async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '111',
        sync_enabled: true,
        last_synced_at: null,
      },
      {
        id: 'link-2',
        user_id: 'user-1',
        manga_id: 'm-2',
        tracker: 'ANILIST',
        tracker_media_id: '222',
        sync_enabled: true,
        last_synced_at: null,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValue({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    // Retry-After well past the helper's ceiling, so it gives up rather than sleeping.
    vi.mocked(axios.post).mockRejectedValue({
      response: { status: 429, headers: { 'retry-after': '600' } },
    });

    const result = await trackerService.pollExternalChanges();

    expect(result.checked).toBe(1); // gave up after the first, didn't try link-2
    expect(result.updated).toBe(0);
  });
});

describe('bulk mark-read pushes to linked trackers', () => {
  // Regression: markChapterAsRead pushed, but markChaptersBulk (and therefore
  // "mark all previous as read") didn't — and the poll only ever pulled, so a bulk
  // mark-read never reached the tracker at all.
  function mockBulkPrisma() {
    prismaMock.manga.findFirst.mockResolvedValueOnce({ id: 'manga-1' }).mockResolvedValueOnce(null);
    prismaMock.chapter.findUnique.mockResolvedValue({ id: 'existing' });
    prismaMock.user_chapter_state.upsert.mockResolvedValue({});
  }

  const chapters = [{ id: 'ch-1' }, { id: 'ch-2' }, { id: 'ch-3' }];

  it('pushes exactly once for the whole batch, not once per chapter', async () => {
    const push = vi.spyOn(trackerService, 'pushProgressIfLinked').mockResolvedValue(undefined);
    mockBulkPrisma();

    await chapterService.markPreviousChaptersAsRead('one-piece', chapters, undefined, 'user-1');

    // One push, because pushProgressIfLinked recomputes the furthest-read chapter itself
    // — three pushes would send the same number three times for no benefit.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('user-1', 'manga-1');
    push.mockRestore();
  });

  it('never pushes on a bulk un-read — progress is monotonic', async () => {
    const push = vi.spyOn(trackerService, 'pushProgressIfLinked').mockResolvedValue(undefined);
    mockBulkPrisma();

    await chapterService.markPreviousChaptersAsUnread('one-piece', chapters, undefined, 'user-1');

    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it('never pushes for an anonymous reader, who has no tracker account to push to', async () => {
    const push = vi.spyOn(trackerService, 'pushProgressIfLinked').mockResolvedValue(undefined);
    mockBulkPrisma();
    prismaMock.chapter.update.mockResolvedValue({});

    await chapterService.markPreviousChaptersAsRead('one-piece', chapters, undefined, undefined);

    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });
});

describe('POST /api/trackers/sync', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/trackers/sync');
    expect(res.status).toBe(401);
  });

  it('syncs only the calling account’s links and reports what it did', async () => {
    mockLoggedInSession();
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
        sync_enabled: true,
        last_synced_at: null,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { Media: { mediaListEntry: { status: 'CURRENT', progress: 0, score: 0 } } } },
    });
    prismaMock.chapter.findMany.mockResolvedValueOnce([]);
    prismaMock.tracker_link.update.mockResolvedValue({});

    const res = await request(app).post('/api/trackers/sync').set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ checked: 1, updated: 0 });
    // Scoped to this user, never the whole table.
    expect(prismaMock.tracker_link.findMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', sync_enabled: true },
    });
  });
});

describe('MyAnimeList tracker (PKCE)', () => {
  beforeEach(() => {
    process.env.MAL_CLIENT_ID = 'mal-client-id';
    process.env.MAL_REDIRECT_URI = 'http://localhost:4000/api/trackers/myanimelist/callback';
  });
  afterEach(() => {
    delete process.env.MAL_CLIENT_ID;
    delete process.env.MAL_CLIENT_SECRET;
    delete process.env.MAL_REDIRECT_URI;
  });

  it('authorize URL includes a PKCE code_challenge using the "plain" method', async () => {
    mockLoggedInSession();
    const res = await request(app)
      .get('/api/trackers/myanimelist/authorize')
      .set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(200);
    const url = new URL(res.body.data.url);
    expect(url.origin + url.pathname).toBe('https://myanimelist.net/v1/oauth2/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('plain');
    expect(url.searchParams.get('code_challenge')!.length).toBeGreaterThanOrEqual(43);
  });

  it('exchanges code+verifier at callback (verifier equals the challenge — "plain" method) and encrypts the tokens', async () => {
    mockLoggedInSession();
    const authRes = await request(app)
      .get('/api/trackers/myanimelist/authorize')
      .set('Cookie', ['pm_session=sess-1']);
    const authUrl = new URL(authRes.body.data.url);
    const state = authUrl.searchParams.get('state')!;
    const codeChallenge = authUrl.searchParams.get('code_challenge')!;

    vi.mocked(axios.post).mockResolvedValueOnce({
      data: {
        access_token: 'mal-access-token',
        refresh_token: 'mal-refresh-token',
        expires_in: 3600,
      },
    });
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: 7, name: 'MalUser' } });
    prismaMock.tracker_account.upsert.mockResolvedValueOnce({ id: 'ta-2' });

    mockLoggedInSession();
    const res = await request(app)
      .get(`/api/trackers/myanimelist/callback?code=real-code&state=${encodeURIComponent(state)}`)
      .set('Cookie', ['pm_session=sess-1']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('tracker_connected=myanimelist');

    const tokenCallBody = vi.mocked(axios.post).mock.calls[0][1] as URLSearchParams;
    expect(tokenCallBody.get('grant_type')).toBe('authorization_code');
    expect(tokenCallBody.get('code_verifier')).toBe(codeChallenge);

    const upsertCall = prismaMock.tracker_account.upsert.mock.calls[0][0] as {
      create: { access_token: string; refresh_token: string };
    };
    expect(decryptToken(upsertCall.create.access_token)).toBe('mal-access-token');
    expect(decryptToken(upsertCall.create.refresh_token)).toBe('mal-refresh-token');
  });
});

describe('access-token refresh', () => {
  it('refreshes an expired MyAnimeList access token transparently before use (MAL supports refresh grants)', async () => {
    process.env.MAL_CLIENT_ID = 'mal-client-id';
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      user_id: 'user-1',
      tracker: 'MYANIMELIST',
      access_token: encryptToken('old-access'),
      refresh_token: encryptToken('old-refresh'),
      expires_at: new Date(Date.now() - 1000),
      tracker_user_id: '7',
      tracker_username: 'MalUser',
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    });
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: [] } });
    prismaMock.tracker_account.upsert.mockResolvedValueOnce({});

    const results = await trackerService.searchMedia('user-1', 'MYANIMELIST', 'One Piece');

    expect(results).toEqual([]);
    const refreshBody = vi.mocked(axios.post).mock.calls[0][1] as URLSearchParams;
    expect(refreshBody.get('grant_type')).toBe('refresh_token');
    expect(refreshBody.get('refresh_token')).toBe('old-refresh');

    const upsertCall = prismaMock.tracker_account.upsert.mock.calls[0][0] as {
      update: { access_token: string };
    };
    expect(decryptToken(upsertCall.update.access_token)).toBe('new-access');
    delete process.env.MAL_CLIENT_ID;
  });

  it('dedupes concurrent refreshes for the same account instead of racing two exchanges of the same refresh_token', async () => {
    process.env.MAL_CLIENT_ID = 'mal-client-id';
    const expiredAccount = {
      user_id: 'user-1',
      tracker: 'MYANIMELIST',
      access_token: encryptToken('old-access'),
      refresh_token: encryptToken('old-refresh'),
      expires_at: new Date(Date.now() - 1000),
      tracker_user_id: '7',
      tracker_username: 'MalUser',
    };
    // Two independent callers (e.g. a chapter mark-read's push and the poll job's pull)
    // each fetch their own copy of the same still-expired account row.
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce(expiredAccount);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce(expiredAccount);
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    });
    vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } });
    prismaMock.tracker_account.upsert.mockResolvedValue({});

    const [first, second] = await Promise.all([
      trackerService.searchMedia('user-1', 'MYANIMELIST', 'One Piece'),
      trackerService.searchMedia('user-1', 'MYANIMELIST', 'One Piece'),
    ]);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    // The refresh grant itself only went out once — the second caller waited on the
    // first's in-flight refresh instead of racing its own exchange of the same
    // refresh_token (which MyAnimeList would reject as already-used on the loser).
    expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1);
    delete process.env.MAL_CLIENT_ID;
  });

  it("fails closed with a 'reconnect' error when AniList's token has expired (AniList has no refresh grant at all)", async () => {
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      user_id: 'user-1',
      tracker: 'ANILIST',
      access_token: encryptToken('old-access'),
      refresh_token: null,
      expires_at: new Date(Date.now() - 1000),
      tracker_user_id: '1',
      tracker_username: 'AniUser',
    });

    await expect(trackerService.searchMedia('user-1', 'ANILIST', 'One Piece')).rejects.toThrow(
      /reconnect/i,
    );
  });
});

describe('trackerService.pushStatusIfLinked', () => {
  it('pushes the mapped native status to every enabled tracker link', async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
        sync_enabled: true,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { SaveMediaListEntry: { id: 1 } } },
    });
    prismaMock.tracker_link.update.mockResolvedValueOnce({});

    await trackerService.pushStatusIfLinked('user-1', 'm-1', 'READING');

    const call = vi.mocked(axios.post).mock.calls[0][1] as { variables: Record<string, unknown> };
    expect(call.variables.status).toBe('CURRENT'); // READING -> AniList's CURRENT
  });

  it('does nothing when shelf_status is null — no tracker-native "no shelf" to push', async () => {
    await trackerService.pushStatusIfLinked('user-1', 'm-1', null);
    expect(prismaMock.tracker_link.findMany).not.toHaveBeenCalled();
  });
});

describe('trackerService.pollExternalChanges — status last-write-wins', () => {
  it('pulls remote status when the tracker changed more recently than the local edit', async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
        sync_enabled: true,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    const remoteUpdatedAt = Math.floor(Date.now() / 1000);
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: {
        data: {
          Media: {
            mediaListEntry: {
              status: 'COMPLETED',
              progress: 0,
              score: 0,
              updatedAt: remoteUpdatedAt,
            },
          },
        },
      },
    });
    prismaMock.chapter.findMany.mockResolvedValueOnce([]); // computeLocalProgress: no chapters at all
    prismaMock.user_manga_state.findUnique.mockResolvedValueOnce({
      updated_at: new Date(Date.now() - 60_000), // a minute ago — older than the remote change
    });
    prismaMock.user_manga_state.upsert.mockResolvedValueOnce({});
    prismaMock.tracker_link.update.mockResolvedValueOnce({});

    const result = await trackerService.pollExternalChanges();

    expect(result.updated).toBe(1);
    expect(prismaMock.user_manga_state.upsert).toHaveBeenCalledWith({
      where: { user_id_manga_id: { user_id: 'user-1', manga_id: 'm-1' } },
      create: { user_id: 'user-1', manga_id: 'm-1', shelf_status: 'COMPLETED' },
      update: { shelf_status: 'COMPLETED', edited_at: null },
    });
  });

  it('does not clobber a local status change that is newer than the remote one', async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
        sync_enabled: true,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    const remoteUpdatedAt = Math.floor((Date.now() - 120_000) / 1000); // 2 minutes ago
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: {
        data: {
          Media: {
            mediaListEntry: {
              status: 'DROPPED',
              progress: 0,
              score: 0,
              updatedAt: remoteUpdatedAt,
            },
          },
        },
      },
    });
    prismaMock.chapter.findMany.mockResolvedValueOnce([]);
    prismaMock.user_manga_state.findUnique.mockResolvedValueOnce({
      updated_at: new Date(), // just now — newer than the remote's 2-minute-old change
    });
    prismaMock.tracker_link.update.mockResolvedValueOnce({});

    const result = await trackerService.pollExternalChanges();

    expect(result.updated).toBe(0);
    expect(prismaMock.user_manga_state.upsert).not.toHaveBeenCalled();
  });
});

describe('trackerService.pushScoreIfLinked', () => {
  it("pushes the score as AniList's scoreRaw (already a fixed 0-100 scale, no conversion needed)", async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
        sync_enabled: true,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { SaveMediaListEntry: { id: 1 } } },
    });
    prismaMock.tracker_link.update.mockResolvedValueOnce({});

    await trackerService.pushScoreIfLinked('user-1', 'm-1', 85);

    const call = vi.mocked(axios.post).mock.calls[0][1] as { variables: Record<string, unknown> };
    expect(call.variables.scoreRaw).toBe(85);
  });

  it('does nothing when score is null', async () => {
    await trackerService.pushScoreIfLinked('user-1', 'm-1', null);
    expect(prismaMock.tracker_link.findMany).not.toHaveBeenCalled();
  });
});

describe('trackerService.pollExternalChanges — score last-write-wins', () => {
  it('pulls the remote score (normalized from scoreRaw) alongside status when the tracker changed more recently', async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'ANILIST',
        tracker_media_id: '777',
        sync_enabled: true,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    const remoteUpdatedAt = Math.floor(Date.now() / 1000);
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: {
        data: {
          Media: {
            mediaListEntry: {
              status: 'COMPLETED',
              progress: 0,
              scoreRaw: 92,
              updatedAt: remoteUpdatedAt,
            },
          },
        },
      },
    });
    prismaMock.chapter.findMany.mockResolvedValueOnce([]);
    prismaMock.user_manga_state.findUnique.mockResolvedValueOnce({
      updated_at: new Date(Date.now() - 60_000),
    });
    prismaMock.user_manga_state.upsert.mockResolvedValueOnce({});
    prismaMock.tracker_link.update.mockResolvedValueOnce({});

    const result = await trackerService.pollExternalChanges();

    expect(result.updated).toBe(1);
    expect(prismaMock.user_manga_state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { shelf_status: 'COMPLETED', score: 92, edited_at: null },
      }),
    );
  });
});

describe("MyAnimeList score conversion (0-10 native scale <-> this app's 0-100 scale)", () => {
  beforeEach(() => {
    process.env.MAL_CLIENT_ID = 'mal-client-id';
  });
  afterEach(() => {
    delete process.env.MAL_CLIENT_ID;
  });

  it('normalizes a MAL score of 7 (out of 10) to 70 (out of 100) when reading, and seeds it locally on link', async () => {
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      user_id: 'user-1',
      tracker: 'MYANIMELIST',
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        my_list_status: {
          status: 'reading',
          num_chapters_read: 0,
          score: 7,
          updated_at: new Date().toISOString(),
        },
      },
    });
    prismaMock.tracker_link.upsert.mockResolvedValueOnce({ id: 'link-1' });
    prismaMock.chapter.findMany.mockResolvedValueOnce([]); // computeLocalProgress: nothing read locally, remote progress is also 0
    prismaMock.user_manga_state.findUnique.mockResolvedValueOnce(null); // no local entry yet — remote wins unconditionally
    prismaMock.user_manga_state.upsert.mockResolvedValueOnce({});

    await trackerService.linkManga('user-1', 'm-1', 'MYANIMELIST', '555');

    expect(prismaMock.user_manga_state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { shelf_status: 'READING', score: 70, edited_at: null } }),
    );
  });

  it('converts an app score of 70 (out of 100) down to 7 (out of 10) when pushing', async () => {
    prismaMock.tracker_link.findMany.mockResolvedValueOnce([
      {
        id: 'link-1',
        user_id: 'user-1',
        manga_id: 'm-1',
        tracker: 'MYANIMELIST',
        tracker_media_id: '555',
        sync_enabled: true,
      },
    ]);
    prismaMock.tracker_account.findUnique.mockResolvedValueOnce({
      access_token: encryptToken('tok'),
      expires_at: null,
    });
    vi.mocked(axios.patch).mockResolvedValueOnce({ data: {} });
    prismaMock.tracker_link.update.mockResolvedValueOnce({});

    await trackerService.pushScoreIfLinked('user-1', 'm-1', 70);

    const patchBody = vi.mocked(axios.patch).mock.calls[0][1] as URLSearchParams;
    expect(patchBody.get('score')).toBe('7');
  });
});
