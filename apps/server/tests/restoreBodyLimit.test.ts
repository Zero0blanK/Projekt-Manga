import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';
import app from '../src/app.js';

describe('restore upload body limit', () => {
  it('rejects a request one byte over the shared limit before restore handling', async () => {
    const response = await request(app)
      .post('/api/restore/jobs')
      .set('Content-Type', 'application/json')
      .send(Buffer.alloc(RESTORE_UPLOAD_LIMIT_BYTES + 1, 0x20));

    expect(response.status).toBe(413);
    expect(JSON.stringify(response.body)).not.toContain('SyntaxError');
  }, 30_000);
});
