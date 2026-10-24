import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

/**
 * A website the reader visits must not be able to change their library or install code
 * through a plain HTML form. These requests are rejected before any handler runs, so no
 * database mock is needed: a request that got through would fail differently.
 */
describe('cross-site write protection', () => {
  const originalClientUrl = process.env.CLIENT_URL;
  afterEach(() => {
    process.env.CLIENT_URL = originalClientUrl;
  });

  it('refuses form-encoded bodies, the only kind a cross-site form can send as a write', async () => {
    const res = await request(app)
      .post('/api/extensions/installed')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('repository_id=repo&source_key=evil');
    expect(res.status).toBe(415);
  });

  it('refuses text/plain bodies', async () => {
    const res = await request(app)
      .post('/api/extensions/repositories')
      .set('Content-Type', 'text/plain')
      .send('{"url":"https://evil.example/index.json"}');
    expect(res.status).toBe(415);
  });

  it('refuses a browser request the browser marks as cross-site', async () => {
    const res = await request(app)
      .post('/api/extensions/repositories')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ url: 'https://evil.example/index.json' });
    expect(res.status).toBe(403);
  });

  it('refuses a foreign Origin when the browser sends no fetch metadata', async () => {
    process.env.CLIENT_URL = 'http://localhost:3000';
    const res = await request(app)
      .post('/api/extensions/repositories')
      .set('Origin', 'https://evil.example')
      .send({ url: 'https://evil.example/index.json' });
    expect(res.status).toBe(403);
  });

  it('lets the app itself through: same-site, same-origin and CLIENT_URL', async () => {
    process.env.CLIENT_URL = 'http://localhost:3000';
    for (const headers of [
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'same-origin' },
      { Origin: 'http://localhost:3000' },
      {},
    ]) {
      // An empty JSON body fails validation (400), which proves the guard let it pass.
      const res = await request(app).post('/api/extensions/repositories').set(headers).send({});
      expect(res.status, JSON.stringify(headers)).toBe(400);
    }
  });

  it('never blocks reads', async () => {
    const res = await request(app).get('/api/health').set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(200);
  });
});
