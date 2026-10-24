import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  getSourceHealthSnapshot,
  recordSourceAttempt,
  recordSourceOperation,
  resetSourceHealthForTests,
} from '../src/services/sourceHealth.service.js';

describe('source operation health', () => {
  afterEach(resetSourceHealthForTests);

  it('tracks successes, safe error categories, and upstream retry-after without retaining messages', () => {
    recordSourceAttempt('test-source', 'browse');
    recordSourceOperation('test-source', 'browse', {
      success: false,
      code: 'RATE_LIMITED',
      retryAfterMs: 30_000,
    });
    const failure = getSourceHealthSnapshot()[0];
    expect(failure.browse?.lastErrorCode).toBe('RATE_LIMITED');
    expect(Date.parse(failure.browse?.retryAfterAt ?? '')).toBeGreaterThan(Date.now());

    recordSourceAttempt('test-source', 'browse');
    recordSourceOperation('test-source', 'browse', { success: true });
    expect(getSourceHealthSnapshot()[0].browse).toMatchObject({
      lastErrorCode: null,
      retryAfterAt: null,
    });
    expect(getSourceHealthSnapshot()[0].browse?.lastSuccessAt).toBeTruthy();
  });

  it('serves only operational timestamps and error categories from the source health route', async () => {
    recordSourceAttempt('test-source', 'update');
    recordSourceOperation('test-source', 'update', { success: false, code: 'TIMEOUT' });
    const response = await request(app).get('/api/source/health');
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({
      sourceId: 'test-source',
      update: { lastErrorCode: 'TIMEOUT', lastSuccessAt: null, retryAfterAt: null },
    });
    expect(JSON.stringify(response.body.data)).not.toMatch(/url|message|detail/i);
  });
});
