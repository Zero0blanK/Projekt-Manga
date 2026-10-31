import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import { decryptToken } from '../src/utils/tokenCrypto.js';
import kitsuTracker, {
  mapKitsuEntry,
  mapKitsuSearch,
  toKitsuRating,
} from '../src/services/trackers/kitsu.tracker.js';
import mangaUpdatesTracker, {
  mapMangaUpdatesEntry,
  mapMangaUpdatesSearch,
} from '../src/services/trackers/mangaupdates.tracker.js';
import shikimoriTracker, {
  mapShikimoriRate,
  mapShikimoriSearch,
} from '../src/services/trackers/shikimori.tracker.js';
import bangumiTracker, {
  mapBangumiCollection,
  mapBangumiSearch,
} from '../src/services/trackers/bangumi.tracker.js';
import komgaTracker, {
  mapKomgaProgress,
  mapKomgaSearch,
} from '../src/services/trackers/komga.tracker.js';
import kavitaTracker, {
  mapKavitaProgress,
  mapKavitaSearch,
} from '../src/services/trackers/kavita.tracker.js';
import { normalizeServerUrl } from '../src/services/trackers/selfHosted.js';
import { listTrackerAvailability } from '../src/services/trackers/index.js';

vi.mock('axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), request: vi.fn() },
}));
import axios from 'axios';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'trackers');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- recorded JSON fixtures
const fixture = (name: string): any =>
  JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8'));

const kitsu = fixture('kitsu');
const mu = fixture('mangaupdates');
const shiki = fixture('shikimori');
const bgm = fixture('bangumi');
const komga = fixture('komga');
const kavita = fixture('kavita');

const ok = (data: unknown) => Promise.resolve({ data });
const httpError = (status: number) =>
  Promise.reject(
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, headers: {} },
    }),
  );

const TEST_KEY = 'x8ZQq0e0mJ0v3s5b0m2M3RG2b1V2wYFhFq0O7wq0O9E=';
const OAUTH_ENV = [
  'SHIKIMORI_CLIENT_ID',
  'SHIKIMORI_CLIENT_SECRET',
  'SHIKIMORI_REDIRECT_URI',
  'BANGUMI_CLIENT_ID',
  'BANGUMI_CLIENT_SECRET',
  'BANGUMI_REDIRECT_URI',
];

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  for (const fn of Object.values(axios) as unknown as { mockReset: () => void }[]) {
    fn.mockReset();
  }
  for (const name of [...OAUTH_ENV, 'TOKEN_ENCRYPTION_KEY', 'TRACKER_ALLOW_PRIVATE_URLS']) {
    delete process.env[name];
  }
});

describe('Kitsu adapter', () => {
  it('maps search results, preferring the English title and falling back to canonical', () => {
    expect(mapKitsuSearch(kitsu.search)).toEqual([
      {
        tracker_media_id: '38',
        title: 'Berserk',
        cover_image_url: 'https://media.kitsu.app/manga/poster_images/38/small.jpg',
      },
      { tracker_media_id: '1', title: 'Shingeki no Kyojin', cover_image_url: null },
    ]);
  });

  it('maps a library entry, converting ratingTwenty to the 0-100 scale', () => {
    expect(mapKitsuEntry(kitsu.entry.data[0])).toEqual({
      status: 'current',
      progress: 42,
      score: 85,
      updated_at: new Date('2026-10-01T12:00:00.000Z'),
    });
    expect(mapKitsuEntry(null)).toBeNull();
  });

  it('converts 0-100 scores back to ratingTwenty, clamped, with 0 clearing', () => {
    expect(toKitsuRating(85)).toBe(17);
    expect(toKitsuRating(1)).toBe(2);
    expect(toKitsuRating(100)).toBe(20);
    expect(toKitsuRating(0)).toBeNull();
  });

  it('round-trips every shelf status', () => {
    for (const shelf of ['READING', 'COMPLETED', 'ON_HOLD', 'PLAN', 'DROPPED'] as const) {
      expect(kitsuTracker.mapToShelfStatus(kitsuTracker.mapFromShelfStatus(shelf))).toBe(shelf);
    }
    expect(kitsuTracker.mapToShelfStatus('something_new')).toBeNull();
  });

  it('connects with the password grant and never keeps the password', async () => {
    vi.mocked(axios.post).mockReturnValueOnce(ok(kitsu.token));
    vi.mocked(axios.get).mockReturnValueOnce(ok(kitsu.self));

    const tokens = await kitsuTracker.connectWithCredentials!({
      username: 'reader@example.com',
      password: 'hunter2',
    });

    expect(tokens).toMatchObject({
      access_token: 'kitsu-access',
      refresh_token: 'kitsu-refresh',
      tracker_user_id: '123456',
      tracker_username: 'reader',
    });
    expect(JSON.stringify(tokens)).not.toContain('hunter2');
    const body = vi.mocked(axios.post).mock.calls[0][1] as URLSearchParams;
    expect(body.get('grant_type')).toBe('password');
  });

  it('reports rejected credentials without echoing them', async () => {
    vi.mocked(axios.post).mockReturnValueOnce(httpError(401));
    const attempt = kitsuTracker.connectWithCredentials!({
      username: 'reader@example.com',
      password: 'hunter2',
    });
    await expect(attempt).rejects.toThrow("Kitsu didn't accept those credentials.");
    await attempt.catch((error: Error) => {
      expect(error.message).not.toContain('hunter2');
      expect(error.message).not.toContain('reader@example.com');
    });
  });

  it('creates a library entry when the title is not in the library yet', async () => {
    vi.mocked(axios.get)
      .mockReturnValueOnce(ok(kitsu.self))
      .mockReturnValueOnce(ok(kitsu.emptyEntry));
    vi.mocked(axios.post).mockReturnValueOnce(ok({}));

    await kitsuTracker.updateProgress('kitsu-access', '38', 5);

    const [url, body] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('https://kitsu.app/api/edge/library-entries');
    expect(body).toMatchObject({
      data: {
        attributes: { status: 'current', progress: 5 },
        relationships: { user: { data: { id: '123456' } }, manga: { data: { id: '38' } } },
      },
    });
  });
});

describe('MangaUpdates adapter', () => {
  it('maps search results, preferring the thumbnail', () => {
    expect(mapMangaUpdatesSearch(mu.search)).toEqual([
      {
        tracker_media_id: '55099564912',
        title: 'Berserk',
        cover_image_url: 'https://cdn.mangaupdates.com/image/thumb/i1.jpg',
      },
      { tracker_media_id: '12345', title: 'No Cover', cover_image_url: null },
    ]);
  });

  it('maps a list entry plus rating; list_id is the status', () => {
    expect(mapMangaUpdatesEntry(mu.listEntry, mu.rating)).toEqual({
      status: '4',
      progress: 120,
      score: 85,
      updated_at: null,
    });
    expect(mangaUpdatesTracker.mapToShelfStatus('4')).toBe('ON_HOLD');
    expect(mangaUpdatesTracker.mapToShelfStatus('101')).toBeNull();
    expect(mapMangaUpdatesEntry(mu.listEntry, null)?.score).toBeNull();
  });

  it('logs in with username/password and stores only the session token', async () => {
    vi.mocked(axios.put).mockReturnValueOnce(ok(mu.login));
    const tokens = await mangaUpdatesTracker.connectWithCredentials!({
      username: 'reader',
      password: 'hunter2',
    });
    expect(tokens).toEqual({
      access_token: 'mu-session',
      refresh_token: null,
      expires_at: null,
      tracker_user_id: '777',
      tracker_username: 'reader',
    });
  });

  it('treats "not on your list" (404) as no entry', async () => {
    vi.mocked(axios.request).mockReturnValueOnce(httpError(404));
    expect(await mangaUpdatesTracker.getProgress('mu-session', '55099564912')).toBeNull();
  });

  it('adds a series to the reading list before setting progress when it is missing', async () => {
    vi.mocked(axios.request).mockReturnValueOnce(httpError(404)).mockReturnValueOnce(ok({}));
    await mangaUpdatesTracker.updateProgress('mu-session', '55099564912', 7);
    expect(vi.mocked(axios.request).mock.calls[1][0]).toMatchObject({
      method: 'post',
      url: 'https://api.mangaupdates.com/v1/lists/series',
      data: [{ series: { id: 55099564912 }, list_id: 0, status: { chapter: 7 } }],
    });
  });

  it('rejects a non-numeric series id before calling out', async () => {
    await expect(mangaUpdatesTracker.getProgress('mu-session', '../account')).rejects.toThrow(
      /Invalid MangaUpdates series id/,
    );
    expect(axios.request).not.toHaveBeenCalled();
  });
});

describe('Shikimori adapter', () => {
  it('maps search results, resolving relative images and dropping placeholders', () => {
    expect(mapShikimoriSearch(shiki.search)).toEqual([
      {
        tracker_media_id: '2',
        title: 'Berserk',
        cover_image_url: 'https://shikimori.one/system/mangas/preview/2.jpg?1',
      },
      { tracker_media_id: '3', title: 'Без обложки', cover_image_url: null },
    ]);
  });

  it('maps a user rate', () => {
    expect(mapShikimoriRate(shiki.rates[0])).toEqual({
      status: 'watching',
      progress: 300,
      score: 90,
      updated_at: new Date('2026-09-15T08:30:00.000+03:00'),
    });
    expect(shikimoriTracker.mapToShelfStatus('watching')).toBe('READING');
    expect(shikimoriTracker.mapFromShelfStatus('READING')).toBe('watching');
  });

  it('is unavailable until its OAuth app is configured', () => {
    expect(shikimoriTracker.isConfigured()).toBe(false);
    process.env.SHIKIMORI_CLIENT_ID = 'id';
    process.env.SHIKIMORI_CLIENT_SECRET = 'secret';
    process.env.SHIKIMORI_REDIRECT_URI = 'http://localhost:4000/api/trackers/shikimori/callback';
    expect(shikimoriTracker.isConfigured()).toBe(true);
    const url = new URL(shikimoriTracker.getAuthUrl!('state-1', 'verifier'));
    expect(url.origin + url.pathname).toBe('https://shikimori.one/oauth/authorize');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toBe('user_rates');
  });

  it('exchanges a code and reads the profile', async () => {
    process.env.SHIKIMORI_CLIENT_ID = 'id';
    process.env.SHIKIMORI_CLIENT_SECRET = 'secret';
    process.env.SHIKIMORI_REDIRECT_URI = 'http://localhost:4000/api/trackers/shikimori/callback';
    vi.mocked(axios.post).mockReturnValueOnce(ok(shiki.token));
    vi.mocked(axios.request).mockReturnValueOnce(ok(shiki.whoami));

    const tokens = await shikimoriTracker.exchangeCode!('code-1', 'verifier');
    expect(tokens).toMatchObject({
      access_token: 'shiki-access',
      refresh_token: 'shiki-refresh',
      tracker_user_id: '4242',
      tracker_username: 'reader',
    });
  });
});

describe('Bangumi adapter', () => {
  it('maps search results, preferring the Chinese title when present', () => {
    expect(mapBangumiSearch(bgm.search)).toEqual([
      {
        tracker_media_id: '8000',
        title: '剑风传奇',
        cover_image_url: 'https://lain.bgm.tv/pic/cover/c/8000.jpg',
      },
      { tracker_media_id: '8001', title: 'No CN Title', cover_image_url: null },
    ]);
  });

  it('maps a collection; its type is the status', () => {
    expect(mapBangumiCollection(bgm.collection)).toEqual({
      status: '3',
      progress: 57,
      score: 80,
      updated_at: new Date('2026-08-20T10:00:00+08:00'),
    });
    expect(bangumiTracker.mapToShelfStatus('3')).toBe('READING');
    expect(bangumiTracker.mapFromShelfStatus('PLAN')).toBe('1');
  });

  it('treats a 404 collection as not tracked', async () => {
    vi.mocked(axios.request).mockReturnValueOnce(ok(bgm.me)).mockReturnValueOnce(httpError(404));
    expect(await bangumiTracker.getProgress('bgm-access', '8000')).toBeNull();
  });

  it('creates a "doing" collection when setting progress on an untracked subject', async () => {
    vi.mocked(axios.request)
      .mockReturnValueOnce(ok(bgm.me))
      .mockReturnValueOnce(httpError(404))
      .mockReturnValueOnce(ok({}));
    await bangumiTracker.updateProgress('bgm-access', '8000', 12);
    expect(vi.mocked(axios.request).mock.calls[2][0]).toMatchObject({
      method: 'post',
      url: 'https://api.bgm.tv/v0/users/-/collections/8000',
      data: { type: 3, ep_status: 12 },
    });
  });
});

describe('Komga adapter', () => {
  it('maps search results without exposing key-protected thumbnails', () => {
    expect(mapKomgaSearch(komga.search)).toEqual([
      { tracker_media_id: '0SERIES1', title: 'Berserk', cover_image_url: null },
      { tracker_media_id: '0SERIES2', title: 'Untitled', cover_image_url: null },
    ]);
  });

  it('derives status from read counts', () => {
    expect(mapKomgaProgress(komga.progressPartial)).toEqual({
      status: 'IN_PROGRESS',
      progress: 12,
      score: null,
      updated_at: null,
    });
    expect(mapKomgaProgress(komga.progressDone).status).toBe('READ');
    expect(mapKomgaProgress(komga.progressNone).status).toBe('UNREAD');
    expect(komgaTracker.mapToShelfStatus('READ')).toBe('COMPLETED');
  });

  it('connects with URL + API key and stores both only inside the encrypted token', async () => {
    process.env.TRACKER_ALLOW_PRIVATE_URLS = 'true';
    vi.mocked(axios.request).mockReturnValueOnce(ok(komga.me));
    const tokens = await komgaTracker.connectWithCredentials!({
      base_url: 'http://komga.lan:25600/',
      api_key: 'komga-key',
    });
    expect(tokens.tracker_username).toBe('reader@example.com');
    expect(JSON.parse(tokens.access_token)).toEqual({
      base_url: 'http://komga.lan:25600',
      api_key: 'komga-key',
    });
    const config = vi.mocked(axios.request).mock.calls[0][0];
    expect(config).toMatchObject({
      url: 'http://komga.lan:25600/api/v2/users/me',
      maxRedirects: 0,
      headers: { 'X-API-Key': 'komga-key' },
    });
  });

  it('sets progress through the tachiyomi read-progress endpoint', async () => {
    vi.mocked(axios.request).mockReturnValueOnce(ok(''));
    const token = JSON.stringify({ base_url: 'https://komga.example.com', api_key: 'k' });
    await komgaTracker.updateProgress(token, '0SERIES1', 15);
    expect(vi.mocked(axios.request).mock.calls[0][0]).toMatchObject({
      method: 'put',
      url: 'https://komga.example.com/api/v2/series/0SERIES1/read-progress/tachiyomi',
      data: { lastBookNumberSortRead: 15 },
    });
  });

  it('reports a rejected key without echoing it', async () => {
    process.env.TRACKER_ALLOW_PRIVATE_URLS = 'true';
    vi.mocked(axios.request).mockReturnValueOnce(httpError(401));
    const attempt = komgaTracker.connectWithCredentials!({
      base_url: 'http://komga.lan',
      api_key: 'super-secret-key',
    });
    await expect(attempt).rejects.toThrow("Komga didn't accept those credentials.");
    await attempt.catch((error: Error) => expect(error.message).not.toContain('super-secret'));
  });
});

describe('Kavita adapter', () => {
  it('maps search results, preferring a localized name', () => {
    expect(mapKavitaSearch(kavita.search)).toEqual([
      { tracker_media_id: '17', title: 'Berserk', cover_image_url: null },
      { tracker_media_id: '18', title: 'バガボンド', cover_image_url: null },
    ]);
  });

  it('maps series + latest chapter to progress and derived status', () => {
    expect(mapKavitaProgress(kavita.series, kavita.latestChapter)).toEqual({
      status: 'IN_PROGRESS',
      progress: 120,
      score: null,
      updated_at: null,
    });
    // 204 No Content when nothing has been read.
    expect(mapKavitaProgress(kavita.series, '').progress).toBe(0);
    expect(mapKavitaProgress(kavita.seriesDone, kavita.latestChapter).status).toBe('READ');
  });

  it('exchanges the API key for a JWT and reuses it across calls', async () => {
    vi.mocked(axios.request)
      .mockReturnValueOnce(ok(kavita.authenticate))
      .mockReturnValueOnce(ok(kavita.search))
      .mockReturnValueOnce(ok(kavita.search));
    const token = JSON.stringify({ base_url: 'https://kavita.example.com', api_key: 'kv-key' });

    await kavitaTracker.searchMedia(token, 'Berserk');
    await kavitaTracker.searchMedia(token, 'Berserk');

    const calls = vi.mocked(axios.request).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      method: 'post',
      url: 'https://kavita.example.com/api/Plugin/authenticate',
      params: { apiKey: 'kv-key', pluginName: 'ProjektManga' },
    });
    expect(calls[2]).toMatchObject({
      url: 'https://kavita.example.com/api/Search/search',
      headers: { Authorization: 'Bearer kavita-jwt' },
    });
  });
});

describe('self-hosted server URL validation', () => {
  it('rejects private, loopback and non-http URLs by default', async () => {
    await expect(normalizeServerUrl('http://127.0.0.1:25600', 'Komga')).rejects.toThrow(
      /publicly reachable/,
    );
    await expect(normalizeServerUrl('http://10.0.0.5', 'Komga')).rejects.toThrow(
      /publicly reachable/,
    );
    await expect(normalizeServerUrl('http://localhost:5000', 'Kavita')).rejects.toThrow(
      /publicly reachable/,
    );
    await expect(normalizeServerUrl('ftp://93.184.216.34', 'Komga')).rejects.toThrow(
      /http:\/\/ or https:\/\//,
    );
    await expect(normalizeServerUrl('https://user:pw@93.184.216.34', 'Komga')).rejects.toThrow(
      /username or password/,
    );
  });

  it('accepts a public address and strips trailing slashes', async () => {
    expect(await normalizeServerUrl('https://93.184.216.34/komga/', 'Komga')).toBe(
      'https://93.184.216.34/komga',
    );
  });

  it('allows private addresses only when the operator opts in', async () => {
    process.env.TRACKER_ALLOW_PRIVATE_URLS = 'true';
    expect(await normalizeServerUrl('http://192.168.1.20:5000', 'Kavita')).toBe(
      'http://192.168.1.20:5000',
    );
  });
});

describe('tracker availability', () => {
  it('lists every tracker, marking OAuth trackers without config unavailable', () => {
    const byTracker = Object.fromEntries(listTrackerAvailability().map((t) => [t.tracker, t]));
    expect(Object.keys(byTracker)).toEqual([
      'ANILIST',
      'MYANIMELIST',
      'KITSU',
      'MANGAUPDATES',
      'SHIKIMORI',
      'BANGUMI',
      'KOMGA',
      'KAVITA',
    ]);
    expect(byTracker.KITSU).toMatchObject({ auth_kind: 'password', available: true });
    expect(byTracker.KOMGA).toMatchObject({ auth_kind: 'api_key', available: true });
    expect(byTracker.SHIKIMORI).toMatchObject({ auth_kind: 'oauth', available: false });
    expect(byTracker.BANGUMI).toMatchObject({ auth_kind: 'oauth', available: false });
  });
});

function mockLoggedInSession(user_id = 'user-1') {
  prismaMock.session.findUnique.mockResolvedValueOnce({
    id: 'sess-1',
    user_id,
    expires_at: new Date(Date.now() + 60_000),
    user: { id: user_id, email: 'reader@example.com', display_name: null, created_at: new Date() },
  });
}

describe('tracker connect routes', () => {
  it('GET /api/trackers/available requires auth and lists trackers', async () => {
    expect((await request(app).get('/api/trackers/available')).status).toBe(401);

    mockLoggedInSession();
    const res = await request(app)
      .get('/api/trackers/available')
      .set('Cookie', ['pm_session=sess-1']);
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { tracker: string }) => t.tracker)).toContain('KAVITA');
  });

  it('POST /:tracker/connect stores the token encrypted and returns no secrets', async () => {
    mockLoggedInSession();
    vi.mocked(axios.put).mockReturnValueOnce(ok(mu.login));
    prismaMock.tracker_account.upsert.mockImplementationOnce(async (args) => ({
      ...args.create,
      id: 'ta-1',
      created_at: new Date('2026-10-28T00:00:00Z'),
      updated_at: new Date(),
    }));

    const res = await request(app)
      .post('/api/trackers/mangaupdates/connect')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ username: 'reader', password: 'hunter2' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      tracker: 'MANGAUPDATES',
      tracker_username: 'reader',
      connected_at: '2026-10-28T00:00:00.000Z',
    });
    expect(JSON.stringify(res.body)).not.toContain('mu-session');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    const stored = prismaMock.tracker_account.upsert.mock.calls[0][0].create;
    expect(stored.access_token).not.toBe('mu-session');
    expect(decryptToken(stored.access_token)).toBe('mu-session');
  });

  it('refuses a credential connect for an OAuth tracker and vice versa', async () => {
    mockLoggedInSession();
    process.env.SHIKIMORI_CLIENT_ID = 'id';
    process.env.SHIKIMORI_CLIENT_SECRET = 'secret';
    process.env.SHIKIMORI_REDIRECT_URI = 'http://localhost:4000/api/trackers/shikimori/callback';
    const connect = await request(app)
      .post('/api/trackers/shikimori/connect')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ username: 'reader', password: 'x' });
    expect(connect.status).toBe(400);

    mockLoggedInSession();
    const authorize = await request(app)
      .get('/api/trackers/kitsu/authorize')
      .set('Cookie', ['pm_session=sess-1']);
    expect(authorize.status).toBe(400);
  });

  it('reports an unconfigured OAuth tracker as unavailable (503) without calling out', async () => {
    mockLoggedInSession();
    const res = await request(app)
      .get('/api/trackers/bangumi/authorize')
      .set('Cookie', ['pm_session=sess-1']);
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/Bangumi isn't set up on this server/);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('rejects a Komga URL on a private network with a safe message', async () => {
    mockLoggedInSession();
    const res = await request(app)
      .post('/api/trackers/komga/connect')
      .set('Cookie', ['pm_session=sess-1'])
      .send({ base_url: 'http://192.168.1.20:25600', api_key: 'super-secret-key' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-key');
    expect(axios.request).not.toHaveBeenCalled();
  });
});
