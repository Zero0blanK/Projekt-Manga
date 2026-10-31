import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import {
  readSourceNetworkConfig,
  setSourceNetworkConfigFileForTests,
} from '../src/utils/sourceNetworkConfig.js';
import { pinnedLookup } from '../src/utils/guardedFetch.js';

let root: string;
let file: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-source-network-'));
  file = path.join(root, 'source-network.json');
  setSourceNetworkConfigFileForTests(file);
});

afterEach(async () => {
  setSourceNetworkConfigFileForTests(null);
  delete process.env.ADMIN_TOKEN;
  delete process.env.SOURCE_USER_AGENT;
  delete process.env.SOURCE_DOH_URL;
  await fs.rm(root, { recursive: true, force: true });
});

describe('source network settings endpoint', () => {
  it('requires the admin check for reads and writes', async () => {
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    // trust proxy is `loopback`, so the forwarded remote address is the one checked.
    const remote = '203.0.113.9';
    expect(
      (await request(app).get('/api/source-network').set('X-Forwarded-For', remote)).status,
    ).toBe(403);
    const write = await request(app)
      .patch('/api/source-network')
      .set('X-Forwarded-For', remote)
      .send({ userAgent: 'Remote/1.0' });
    expect(write.status).toBe(403);
    await expect(fs.access(file)).rejects.toThrow();

    const withToken = await request(app)
      .patch('/api/source-network')
      .set('X-Forwarded-For', remote)
      .set('X-Admin-Token', 'a-sixteen-char-token')
      .send({ userAgent: 'Remote/1.0' });
    expect(withToken.status).toBe(200);
    expect(withToken.body.data).toEqual({ userAgent: 'Remote/1.0', dohUrl: null });
  });

  it('starts from the environment defaults', async () => {
    process.env.SOURCE_USER_AGENT = 'Env-UA/1.0';
    process.env.SOURCE_DOH_URL = 'https://1.1.1.1/dns-query';
    setSourceNetworkConfigFileForTests(file);
    const res = await request(app).get('/api/source-network');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual({
      userAgent: 'Env-UA/1.0',
      dohUrl: 'https://1.1.1.1/dns-query',
    });
  });

  it('saves overrides, lets null turn an env default off, and persists across restarts', async () => {
    process.env.SOURCE_DOH_URL = 'https://1.1.1.1/dns-query';
    setSourceNetworkConfigFileForTests(file);
    const res = await request(app)
      .patch('/api/source-network')
      .send({ userAgent: '  Custom-UA/3.0  ', dohUrl: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ userAgent: 'Custom-UA/3.0', dohUrl: null });
    expect(readSourceNetworkConfig()).toEqual({ userAgent: 'Custom-UA/3.0', dohUrl: null });

    // A partial update leaves the other field alone.
    await request(app)
      .patch('/api/source-network')
      .send({ dohUrl: 'https://dns.google/resolve' })
      .expect(200);
    setSourceNetworkConfigFileForTests(file);
    expect(readSourceNetworkConfig()).toEqual({
      userAgent: 'Custom-UA/3.0',
      dohUrl: 'https://dns.google/resolve',
    });
  });

  it.each([
    [{ userAgent: 'Bad\r\nX-Injected: 1' }],
    [{ userAgent: '' }],
    [{ userAgent: 'x'.repeat(513) }],
    [{ userAgent: 42 }],
    [{ dohUrl: 'http://1.1.1.1/dns-query' }],
    [{ dohUrl: 'https://user:secret@dns.example/dns-query' }],
    [{ dohUrl: 'not a url' }],
    [{ dohUrl: 'file:///etc/hosts' }],
    [{ allowedHosts: ['10.0.0.1'] }],
  ])('rejects invalid input %j without saving it', async (body) => {
    const res = await request(app).patch('/api/source-network').send(body);
    expect(res.status).toBe(400);
    await expect(fs.access(file)).rejects.toThrow();
    expect(readSourceNetworkConfig()).toEqual({ userAgent: null, dohUrl: null });
  });

  it('ignores invalid values in a hand-edited settings file', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ userAgent: 'ok\nX-Evil: 1', dohUrl: 'http://plain.example/' }),
    );
    setSourceNetworkConfigFileForTests(file);
    expect(readSourceNetworkConfig()).toEqual({ userAgent: null, dohUrl: null });
  });
});

describe('pinnedLookup', () => {
  const lookup = (pin: { address: string; family: 4 | 6 }, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) => {
      pinnedLookup(pin)('manga.example', { all }, (error, address, family) =>
        resolve({ error, address, family }),
      );
    });

  it('answers with the pinned public address in both callback shapes', async () => {
    expect(await lookup({ address: '93.184.216.34', family: 4 }, false)).toEqual({
      error: null,
      address: '93.184.216.34',
      family: 4,
    });
    expect((await lookup({ address: '2606:4700::1111', family: 6 }, true)).address).toEqual([
      { address: '2606:4700::1111', family: 6 },
    ]);
  });

  it('refuses a private pin even though the caller validated it', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.5']) {
      expect((await lookup({ address, family: 4 }, false)).error?.name).toBe('UnsafeUrlError');
    }
    expect((await lookup({ address: '::1', family: 6 }, true)).error?.name).toBe('UnsafeUrlError');
  });
});
