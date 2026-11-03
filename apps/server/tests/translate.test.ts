import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { resetTranslateState } from '../src/services/translate.service.js';

// A stand-in translation service on localhost: never a real LibreTranslate or DeepL.
type Sent = { q?: string[]; text?: string[] } & Record<string, unknown>;
const received: Array<{ path: string; headers: IncomingMessage['headers']; body: Sent }> = [];
let reply: (body: Sent) => { status: number; json: unknown } = () => ({ status: 200, json: {} });
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      received.push({ path: req.url ?? '', headers: req.headers, body });
      const { status, json } = reply(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  received.length = 0;
  resetTranslateState();
  delete process.env.TRANSLATE_PROVIDER;
  delete process.env.TRANSLATE_URL;
  delete process.env.TRANSLATE_API_KEY;
});

const libre = (body: Sent) => ({
  status: 200,
  json: { translatedText: (body.q ?? []).map((text) => `EN(${text})`) },
});

describe('page translation', () => {
  it('reports that translation is off until the host sets it up', async () => {
    const status = await request(app).get('/api/translate/status');
    expect(status.body.data).toEqual({
      enabled: false,
      provider: null,
      origin: null,
      server_configured: false,
      source: 'ja',
    });
    const res = await request(app)
      .post('/api/translate')
      .send({ texts: ['こんにちは'], target: 'en' });
    expect(res.status).toBe(503);
  });

  it('sends only the text to LibreTranslate, from Japanese, and caches repeats', async () => {
    process.env.TRANSLATE_PROVIDER = 'libretranslate';
    process.env.TRANSLATE_URL = `${base}/lt/`;
    reply = libre;
    const res = await request(app)
      .post('/api/translate')
      .send({ texts: ['こんにちは', 'ありがとう', 'こんにちは'], target: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.data.translations).toEqual([
      'EN(こんにちは)',
      'EN(ありがとう)',
      'EN(こんにちは)',
    ]);
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/lt/translate');
    // De-duplicated, and no key unless one is set.
    expect(received[0].body).toEqual({
      q: ['こんにちは', 'ありがとう'],
      source: 'ja',
      target: 'en',
      format: 'text',
    });

    await request(app)
      .post('/api/translate')
      .send({ texts: ['ありがとう'], target: 'en' });
    expect(received).toHaveLength(1);
  });

  it('uses DeepL language names and the auth header, without echoing the key', async () => {
    process.env.TRANSLATE_PROVIDER = 'deepl';
    process.env.TRANSLATE_URL = base;
    process.env.TRANSLATE_API_KEY = 'secret-key:fx';
    reply = (body) => ({
      status: 200,
      json: { translations: (body.text ?? []).map((text) => ({ text: `PT(${text})` })) },
    });
    const res = await request(app)
      .post('/api/translate')
      .send({ texts: ['猫'], target: 'pt' });
    expect(res.body.data.translations).toEqual(['PT(猫)']);
    expect(received[0].path).toBe('/v2/translate');
    expect(received[0].headers.authorization).toBe('DeepL-Auth-Key secret-key:fx');
    expect(received[0].body).toMatchObject({ source_lang: 'JA', target_lang: 'PT-BR' });

    reply = () => ({ status: 403, json: { message: 'bad key secret-key:fx' } });
    const failed = await request(app)
      .post('/api/translate')
      .send({ texts: ['犬'], target: 'pt' });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain('secret-key');
    expect(failed.body.message).toContain('HTTP 403');
  });

  it('rejects a malformed answer, bad input and too many calls', async () => {
    process.env.TRANSLATE_PROVIDER = 'libretranslate';
    process.env.TRANSLATE_URL = base;
    reply = () => ({ status: 200, json: { translatedText: 'not a list' } });
    const odd = await request(app)
      .post('/api/translate')
      .send({ texts: ['猫'], target: 'en' });
    expect(odd.status).toBe(502);

    for (const body of [
      { texts: [], target: 'en' },
      { texts: ['猫'], target: 'xx' },
      { texts: ['猫'], target: 'en', source: 'zh' },
      { texts: Array.from({ length: 61 }, () => '猫'), target: 'en' },
    ]) {
      expect((await request(app).post('/api/translate').send(body)).status).toBe(400);
    }

    reply = libre;
    let last = 200;
    for (let i = 0; i < 31; i++) {
      last = (
        await request(app)
          .post('/api/translate')
          .send({ texts: [`猫${i}`], target: 'en' })
      ).status;
    }
    expect(last).toBe(429);
  });
});
