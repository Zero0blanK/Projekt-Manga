import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prismaMock } from './mocks/prismaMock.js';
import { decryptToken } from '../src/utils/tokenCrypto.js';

const TEST_KEY = 'x8ZQq0e0mJ0v3s5b0m2M3RG2b1V2wYFhFq0O7wq0O9E='; // 32 real random bytes, base64

const challengedSource = {
  id: 'cf-source',
  name: 'CF Source',
  lang: 'en',
  base_url: 'https://www.cf.example',
  isNSFW: false,
  getFilters: vi.fn(async () => {
    throw Object.assign(new Error('CF Source is asking for a browser check (Cloudflare).'), {
      code: 'CHALLENGE_REQUIRED',
      reason: 'Cloudflare challenge',
    });
  }),
};

vi.mock('../src/services/sandboxedSourceRegistry.service.js', () => ({
  getInstalledSandboxedSources: vi.fn(async () => [challengedSource]),
  getInstalledSandboxedSource: vi.fn(async (id: string) =>
    id === challengedSource.id ? challengedSource : undefined,
  ),
}));

const { default: app } = await import('../src/app.js');
const { browserSessionFor, forgetBrowserSessions, imageSessionHeaders } =
  await import('../src/services/sourceBrowserSession.service.js');

const installedRow = {
  id: 'ext-1',
  source_key: 'cf-source',
  enabled: true,
  allowed_hosts: ['cf.example'],
};

function cookie(name: string, value: string, domain: string, extra: object = {}) {
  return {
    name,
    value,
    domain,
    hostOnly: false,
    path: '/',
    secure: true,
    httpOnly: true,
    ...extra,
  };
}

/** The rows `replaceForSource` created, as the mock saw them. */
function createdRows() {
  return prismaMock.source_browser_session.create.mock.calls.map(
    (call) =>
      (
        call[0] as {
          data: { source_key: string; host: string; cookies_encrypted: string; user_agent: string };
        }
      ).data,
  );
}

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  forgetBrowserSessions();
  prismaMock.installed_extension.findMany.mockResolvedValue([installedRow]);
});

afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  forgetBrowserSessions();
});

describe('source browser sessions', () => {
  it('stores captured cookies encrypted, for allowed hosts only, and never echoes them', async () => {
    const now = new Date('2026-10-28T10:00:00.000Z');
    prismaMock.source_browser_session.findMany.mockResolvedValue([
      {
        source_key: 'cf-source',
        host: 'cf.example',
        cookies_encrypted: 'x',
        user_agent: 'UA',
        updated_at: now,
      },
    ]);

    const res = await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({
        userAgent: 'Mozilla/5.0 Test',
        cookies: [
          cookie('cf_clearance', 'clearance-secret', '.cf.example'),
          cookie('session', 'login-secret', 'www.cf.example', { hostOnly: true }),
          // Third-party cookies the page loaded: not this source's to keep.
          cookie('tracker', 'ad-secret', '.ads.example'),
          cookie('evil', 'x', 'example', { hostOnly: false }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sourceId: 'cf-source',
      hosts: ['cf.example'],
      updatedAt: now.toISOString(),
      userAgent: 'Mozilla/5.0 Test',
    });
    // Names and expiry only: enough to show what is saved, never the values.
    expect(res.body.data.cookies).toEqual(
      expect.arrayContaining([
        { name: 'cf_clearance', domain: 'cf.example', expires: null },
        { name: 'session', domain: 'www.cf.example', expires: null },
      ]),
    );
    expect(res.body.data.cookies).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);

    const rows = createdRows();
    expect(rows.map((row) => row.host).sort()).toEqual(['cf.example', 'www.cf.example']);
    for (const row of rows) {
      expect(row.source_key).toBe('cf-source');
      expect(row.user_agent).toBe('Mozilla/5.0 Test');
      // Encrypted at rest; the round-trip gives back exactly what was kept.
      expect(row.cookies_encrypted).not.toMatch(/secret/);
    }
    const stored = rows.flatMap(
      (row) =>
        JSON.parse(decryptToken(row.cookies_encrypted)) as Array<{ name: string; value: string }>,
    );
    expect(stored.map((c) => `${c.name}=${c.value}`).sort()).toEqual([
      'cf_clearance=clearance-secret',
      'session=login-secret',
    ]);
  });

  it('hands the sandbox the stored cookies and User-Agent for matching URLs', async () => {
    prismaMock.source_browser_session.findMany.mockResolvedValue([]);
    await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({
        userAgent: 'Mozilla/5.0 Test',
        cookies: [
          cookie('cf_clearance', 'abc', '.cf.example'),
          cookie('session', 'def', 'www.cf.example', { hostOnly: true }),
        ],
      })
      .expect(200);

    const session = browserSessionFor('cf-source');
    expect(await session.headersFor(new URL('https://www.cf.example/manga'))).toEqual({
      cookie: 'cf_clearance=abc; session=def',
      userAgent: 'Mozilla/5.0 Test',
    });
    expect(await session.headersFor(new URL('https://img.cf.example/1.jpg'))).toEqual({
      cookie: 'cf_clearance=abc',
      userAgent: 'Mozilla/5.0 Test',
    });
  });

  it("gives images on the source's own hosts the session, and no other host", async () => {
    prismaMock.source_browser_session.findMany.mockResolvedValue([]);
    await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({
        userAgent: 'Mozilla/5.0 Test',
        cookies: [cookie('cf_clearance', 'abc', 'cf.example')],
      })
      .expect(200);

    expect(await imageSessionHeaders('cf-source', new URL('https://img.cf.example/1.jpg'))).toEqual(
      { Cookie: 'cf_clearance=abc', 'User-Agent': 'Mozilla/5.0 Test' },
    );
    expect(
      await imageSessionHeaders('cf-source', new URL('https://cdn.other.example/1.jpg')),
    ).toEqual({});
    expect(await imageSessionHeaders('other-source', new URL('https://cf.example/1.jpg'))).toEqual(
      {},
    );
  });

  it('loads a stored session from the database and skips rows it cannot decrypt', async () => {
    // Encrypt the way the service does, by saving once and capturing the row.
    prismaMock.source_browser_session.findMany.mockResolvedValue([]);
    await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({ userAgent: 'UA/2', cookies: [cookie('cf_clearance', 'abc', 'cf.example')] })
      .expect(200);
    const [saved] = createdRows();
    forgetBrowserSessions();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prismaMock.source_browser_session.findMany.mockResolvedValue([
      { ...saved, updated_at: new Date() },
      {
        ...saved,
        host: 'broken.cf.example',
        cookies_encrypted: 'not:valid:ciphertext',
        updated_at: new Date(),
      },
    ]);
    const headers = await browserSessionFor('cf-source').headersFor(new URL('https://cf.example/'));
    expect(headers).toEqual({ cookie: 'cf_clearance=abc', userAgent: 'UA/2' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken.cf.example'));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/abc/);
    warn.mockRestore();
  });

  it('gives a source without a stored session no extra headers', async () => {
    prismaMock.source_browser_session.findMany.mockResolvedValue([]);
    expect(
      await browserSessionFor('cf-source').headersFor(new URL('https://cf.example/')),
    ).toBeNull();
  });

  it('refuses a source that is not installed, and an invalid body', async () => {
    prismaMock.installed_extension.findMany.mockResolvedValue([]);
    await request(app)
      .put('/api/source/missing/browser-session')
      .send({ userAgent: 'UA', cookies: [] })
      .expect(404);
    await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({ userAgent: '', cookies: 'nope' })
      .expect(400);
  });

  it('fails closed with 503 when the server has no encryption key', async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const res = await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({ userAgent: 'UA', cookies: [cookie('cf_clearance', 'abc', 'cf.example')] });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/TOKEN_ENCRYPTION_KEY/);
    expect(prismaMock.source_browser_session.create).not.toHaveBeenCalled();
  });

  it('keeps refreshed cookies when the source is respawned before they were saved', async () => {
    prismaMock.source_browser_session.findMany.mockResolvedValue([]);
    await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({ userAgent: 'UA', cookies: [cookie('cf_clearance', 'old', '.cf.example')] })
      .expect(200);
    prismaMock.source_browser_session.create.mockClear();

    // Cloudflare reissues the clearance; the write waits on the persist timer...
    await browserSessionFor('cf-source').receiveSetCookies(new URL('https://cf.example/'), [
      'cf_clearance=new; Domain=cf.example; Path=/',
    ]);
    // ...and an update respawns the source inside that window.
    forgetBrowserSessions('cf-source');
    await vi.waitFor(() => expect(createdRows()).toHaveLength(1));
    const [row] = createdRows();
    expect(JSON.parse(decryptToken(row.cookies_encrypted))).toEqual([
      expect.objectContaining({ name: 'cf_clearance', value: 'new' }),
    ]);
  });

  it('never keeps a cookie scoped to a public suffix shared by two allowed sites', async () => {
    prismaMock.installed_extension.findMany.mockResolvedValue([
      { ...installedRow, allowed_hosts: ['a.co.uk', 'b.co.uk'] },
    ]);
    prismaMock.source_browser_session.findMany.mockResolvedValue([]);
    await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({
        userAgent: 'UA',
        cookies: [cookie('shared', 'x', '.co.uk'), cookie('own', 'y', 'a.co.uk')],
      })
      .expect(200);
    const session = browserSessionFor('cf-source');
    // The other site gets no cookie at all.
    expect((await session.headersFor(new URL('https://b.co.uk/')))?.cookie).toBeFalsy();
    expect((await session.headersFor(new URL('https://a.co.uk/')))?.cookie).toBe('own=y');
  });

  it('changes only the User-Agent when no cookies are sent, keeping the stored ones', async () => {
    prismaMock.source_browser_session.findMany.mockResolvedValue([]);
    await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({ userAgent: 'Old UA', cookies: [cookie('cf_clearance', 'abc', 'cf.example')] })
      .expect(200);

    const res = await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({ userAgent: 'New UA' })
      .expect(200);

    expect(res.body.data).toMatchObject({
      userAgent: 'New UA',
      cookies: [{ name: 'cf_clearance', domain: 'cf.example', expires: null }],
    });
    expect(await browserSessionFor('cf-source').headersFor(new URL('https://cf.example/'))).toEqual(
      { cookie: 'cf_clearance=abc', userAgent: 'New UA' },
    );
  });

  it('refuses a User-Agent change when there are no cookies to keep', async () => {
    prismaMock.source_browser_session.findMany.mockResolvedValue([]);
    const res = await request(app)
      .put('/api/source/cf-source/browser-session')
      .send({ userAgent: 'New UA' });
    expect(res.status).toBe(400);
  });

  it('clears a session', async () => {
    await request(app).delete('/api/source/cf-source/browser-session').expect(200);
    expect(prismaMock.source_browser_session.deleteMany).toHaveBeenCalledWith({
      where: { source_key: 'cf-source' },
    });
    expect(
      await browserSessionFor('cf-source').headersFor(new URL('https://cf.example/')),
    ).toBeNull();
  });

  it('reports a CHALLENGE_REQUIRED source failure as 503 with a machine-readable code', async () => {
    const res = await request(app).get('/api/source/cf-source/filters');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: 'CHALLENGE_REQUIRED' });
  });
});
