import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import { resetTranslateState } from '../src/services/translate.service.js';
import { generateEncryptionKey } from '../src/utils/tokenCrypto.js';

/**
 * A reader's own translation service. The rows live in a small in-memory store behind the
 * Prisma mock, so what is asserted is exactly what would be written: the key only ever
 * encrypted, and never in a response.
 */

const KEY = 'my-deepl-key-1234567890:fx';
type Row = {
  id: string;
  user_id: string | null;
  provider: string;
  url: string | null;
  key_encrypted: string | null;
  created_at: Date;
  updated_at: Date;
};
let rows: Map<string, Row>;

const received: Array<{ path: string; headers: IncomingMessage['headers']; body: unknown }> = [];
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { text?: string[]; q?: string[] };
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          body.text
            ? { translations: body.text.map((text) => ({ text: `OWN(${text})` })) }
            : { translatedText: (body.q ?? []).map((text) => `LT(${text})`) },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  rows = new Map();
  process.env.TOKEN_ENCRYPTION_KEY = generateEncryptionKey();
  const model = prismaMock.translation_setting;
  model.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
  );
  model.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { id: string };
      create: Omit<Row, 'created_at' | 'updated_at'>;
      update: Partial<Row>;
    }) => {
      const now = new Date();
      const existing = rows.get(where.id);
      const row = existing
        ? { ...existing, ...update, updated_at: now }
        : { ...create, created_at: now, updated_at: now };
      rows.set(where.id, row as Row);
      return row;
    },
  );
  model.deleteMany.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const had = rows.delete(where.id);
    return { count: had ? 1 : 0 };
  });
});

afterEach(() => {
  received.length = 0;
  resetTranslateState();
  for (const name of [
    'TOKEN_ENCRYPTION_KEY',
    'TRANSLATE_PROVIDER',
    'TRANSLATE_URL',
    'TRANSLATE_API_KEY',
    'TRANSLATE_ALLOW_PRIVATE_HOSTS',
  ])
    delete process.env[name];
});

const save = (body: Record<string, unknown>) =>
  request(app).put('/api/translate/settings').send(body);

describe('translation settings', () => {
  it('stores the API key only encrypted and never returns it', async () => {
    const res = await save({ provider: 'deepl', url: base, api_key: KEY });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: 'deepl',
      url: base,
      has_key: true,
      key_readable: true,
    });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(JSON.stringify(res.body)).not.toContain('key_encrypted');

    const stored = rows.get('local')!;
    expect(stored.key_encrypted).toBeTruthy();
    expect(stored.key_encrypted).not.toContain(KEY);
    expect(stored.key_encrypted).not.toContain(KEY.slice(0, 8));

    const read = await request(app).get('/api/translate/settings');
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body.data).toMatchObject({ provider: 'deepl', has_key: true });
    expect(JSON.stringify(read.body)).not.toContain(KEY);
  });

  it('keeps the saved key when a save leaves it out, and replaces or clears it on request', async () => {
    await save({ provider: 'libretranslate', url: base, api_key: 'first-key' });
    const firstCipher = rows.get('local')!.key_encrypted;

    // The settings form never sends the key back: an empty field means "keep it".
    const kept = await save({ provider: 'libretranslate', url: `${base}/lt` });
    expect(kept.body.data.has_key).toBe(true);
    expect(rows.get('local')!.key_encrypted).toBe(firstCipher);

    await save({ provider: 'libretranslate', url: base, api_key: 'second-key' });
    expect(rows.get('local')!.key_encrypted).not.toBe(firstCipher);

    const cleared = await save({ provider: 'libretranslate', url: base, clear_api_key: true });
    expect(cleared.body.data.has_key).toBe(false);
    expect(rows.get('local')!.key_encrypted).toBeNull();
  });

  it('uses the saved service ahead of the host one, with the decrypted key', async () => {
    process.env.TRANSLATE_PROVIDER = 'libretranslate';
    process.env.TRANSLATE_URL = base;
    process.env.TRANSLATE_ALLOW_PRIVATE_HOSTS = 'true';
    await save({ provider: 'deepl', url: base, api_key: KEY });

    const status = await request(app).get('/api/translate/status');
    expect(status.body.data).toMatchObject({
      enabled: true,
      provider: 'deepl',
      origin: 'account',
      server_configured: true,
    });

    const res = await request(app)
      .post('/api/translate')
      .send({ texts: ['猫'], target: 'en' });
    expect(res.body.data.translations).toEqual(['OWN(猫)']);
    expect(received[0].path).toBe('/v2/translate');
    expect(received[0].headers.authorization).toBe(`DeepL-Auth-Key ${KEY}`);

    // Removing it falls back to the host's service.
    await request(app).delete('/api/translate/settings');
    resetTranslateState();
    const fallback = await request(app)
      .post('/api/translate')
      .send({ texts: ['猫'], target: 'en' });
    expect(fallback.body.data.translations).toEqual(['LT(猫)']);
  });

  it("refuses a saved private address unless the host allows it, and doesn't leak the key", async () => {
    await save({ provider: 'deepl', url: base, api_key: KEY });

    const refused = await request(app)
      .post('/api/translate')
      .send({ texts: ['猫'], target: 'en' });
    expect(refused.status).toBe(502);
    expect(refused.body.message).toContain('not public');
    expect(JSON.stringify(refused.body)).not.toContain(KEY);
    expect(received).toHaveLength(0);
  });

  it('says why a key cannot be saved without TOKEN_ENCRYPTION_KEY, and stores nothing', async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const res = await save({ provider: 'deepl', api_key: KEY });
    expect(res.status).toBe(503);
    expect(res.body.message).toContain('TOKEN_ENCRYPTION_KEY');
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(rows.size).toBe(0);
  });

  it('reports a key that can no longer be decrypted instead of using it', async () => {
    await save({ provider: 'deepl', api_key: KEY });
    process.env.TOKEN_ENCRYPTION_KEY = generateEncryptionKey();

    const read = await request(app).get('/api/translate/settings');
    expect(read.body.data).toMatchObject({ has_key: true, key_readable: false });
    const status = await request(app).get('/api/translate/status');
    expect(status.body.data.enabled).toBe(false);
  });

  it('validates what can be saved', async () => {
    for (const body of [
      { provider: 'deepl' },
      { provider: 'libretranslate' },
      { provider: 'google', api_key: KEY },
      { provider: 'deepl', api_key: 'has space' },
      { provider: 'deepl', api_key: KEY, clear_api_key: true },
      { provider: 'libretranslate', url: 'ftp://example.com' },
      { provider: 'libretranslate', url: 'https://user:pw@example.com' },
      { provider: 'libretranslate', url: 'https://example.com/?key=1' },
      { provider: 'deepl', api_key: KEY, extra: true },
    ]) {
      const res = await save(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(KEY);
    }
    expect(rows.size).toBe(0);
  });
});
