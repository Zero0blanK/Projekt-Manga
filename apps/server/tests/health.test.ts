import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import {
  recordDiagnosticEvent,
  resetDiagnosticEventsForTests,
} from '../src/utils/diagnosticLog.js';

afterEach(resetDiagnosticEventsForTests);

describe('health access', () => {
  it('returns a validated correlation id and honors a valid upstream id', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const response = await request(app).get('/api/health').set('X-Request-Id', id);
    expect(response.headers['x-request-id']).toBe(id);
  });

  it('keeps liveness public but protects detailed scraper diagnostics', async () => {
    const live = await request(app).get('/api/health');
    expect(live.status).toBe(200);
    const details = await request(app).get('/api/health/scraper');
    expect(details.status).toBe(401);
  });

  it('reports ready only while the database answers', async () => {
    const ready = await request(app).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data).toMatchObject({ status: 'ready', database: 'ok' });
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1');
  });

  it('answers 503 — not 200 or 500 — when the database is unreachable, and leaks no path', async () => {
    // The whole point of readiness existing next to liveness: this exact state used to
    // answer 200 on /api/health, so a proxy kept routing traffic to a server that could
    // not serve a single data request.
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(
      new Error('SQLITE_CANTOPEN: unable to open database file C:/Users/someone/data/pm.db'),
    );

    const response = await request(app).get('/api/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(JSON.stringify(response.body)).not.toMatch(/SQLITE_CANTOPEN|Users|\.db/);

    const live = await request(app).get('/api/health');
    expect(live.status).toBe(200);
  });

  it('returns only bounded, allowlisted operational events from the report endpoint', async () => {
    recordDiagnosticEvent({
      level: 'warn',
      area: 'sync',
      event: 'sync.push.rows_failed',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      code: 'ROW_APPLY_FAILED',
      counts: { failed: 2 },
    });

    const response = await request(app).get('/api/health/diagnostics');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data[0]).toMatchObject({
      area: 'sync',
      event: 'sync.push.rows_failed',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      code: 'ROW_APPLY_FAILED',
      counts: { failed: 2 },
    });
    expect(JSON.stringify(response.body.data)).not.toMatch(/message|url|path|token/i);
  });

  it('reports runtime facts as booleans and counts, never configured values', async () => {
    const secret = 'a3f1c9d84b2e7f0a15c6d93b8e4f7a2c';
    process.env.TOKEN_ENCRYPTION_KEY = secret;
    process.env.TRANSLATE_PROVIDER = 'https://user:pw@translate.example.com';
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('_prisma_migrations'))
        return [
          { migration_name: '20260101_init', finished_at: new Date(), rolled_back_at: null },
          { migration_name: '20260202_broken', finished_at: null, rolled_back_at: null },
        ];
      if (sql.includes('FROM downloads')) return [{ status: 'FAILED', n: 3n }];
      if (sql.includes('FROM users')) throw new Error('no such table: users at C:/Users/x/pm.db');
      return [{ n: 7n }];
    });
    try {
      const response = await request(app).get('/api/health/runtime');

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.data).toMatchObject({
        migrations: { applied: 1, latest: '20260101_init', failed: 1 },
        counts: { titles: 7, users: null },
        downloads: { FAILED: 3 },
        features: { tokenEncryptionKey: true, translate: 'other' },
      });
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(secret);
      expect(body).not.toMatch(/translate\.example|no such table|Users/);
    } finally {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      delete process.env.TRANSLATE_PROVIDER;
    }
  });
});
