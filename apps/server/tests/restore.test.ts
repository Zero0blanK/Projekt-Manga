import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  startRestore,
  getRestore,
  cancelRestore,
  previewRestore,
} from '../src/services/restore.service.js';

vi.mock('../src/services/restore.service.js', () => ({
  startRestore: vi.fn(),
  getRestore: vi.fn(),
  cancelRestore: vi.fn(),
  previewRestore: vi.fn(),
}));

describe('background restore API', () => {
  beforeEach(() => vi.clearAllMocks());
  it('returns a validated, read-only restore comparison', async () => {
    const preview = {
      matchingTitles: 1,
      addedTitles: 0,
      importedTitles: 1,
      catalogRowsUpdated: 1,
      catalogUpdateExamples: ['Example'],
      chapterIdentityConflicts: 1,
      chapterIdentityConflictExamples: ['Example (chapter 2)'],
      retainedHistory: 0,
      addedHistory: 0,
    };
    vi.mocked(previewRestore).mockResolvedValue(preview);
    const response = await request(app).post('/api/restore/preview').send({
      expectedUserId: null,
      version: 2,
      manga: [],
      library: [],
      history: [],
      mode: 'merge',
    });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data).toEqual(preview);
    expect(previewRestore).toHaveBeenCalledOnce();
    expect(startRestore).not.toHaveBeenCalled();
  });

  it('does not preview backup data after the browser session changes', async () => {
    const response = await request(app).post('/api/restore/preview').send({
      expectedUserId: 'previous-account',
      version: 2,
      manga: [],
      library: [],
      history: [],
      mode: 'merge',
    });

    expect(response.status).toBe(401);
    expect(previewRestore).not.toHaveBeenCalled();
  });

  it('returns a queued job and reports its persisted status', async () => {
    const jobId = 'b48c4704-1e9b-462a-a9d8-9adf98b1dc3e';
    const payload = {
      jobId,
      expectedUserId: null,
      version: 2,
      manga: [],
      library: [],
      history: [],
    };
    vi.mocked(startRestore).mockResolvedValue({
      id: jobId,
      owner: 'anonymous',
      state: 'queued',
      result: null,
      progress: null,
    });
    vi.mocked(getRestore).mockResolvedValue({
      id: jobId,
      owner: 'anonymous',
      state: 'succeeded',
      result: { restoredManga: 0, restoredProgress: 0, restoredHistory: 0 },
      progress: null,
    });
    const start = await request(app).post('/api/restore/jobs').send(payload);
    expect(start.status).toBe(202);
    expect(start.body.data.id).toBe(jobId);
    const duplicate = await request(app).post('/api/restore/jobs').send(payload);
    expect(duplicate.status).toBe(202);
    expect(startRestore).toHaveBeenCalledTimes(2);
    const done = await request(app).get(`/api/restore/jobs/${jobId}`);
    expect(done.body.data.state).toBe('succeeded');
  });

  it('rejects malformed data before creating a job', async () => {
    const response = await request(app).post('/api/restore/jobs').send({
      jobId: 'invalid',
      expectedUserId: null,
      version: 2,
      manga: [],
      library: [],
      history: [],
    });
    expect(response.status).toBe(400);
  });

  it('reports whether a queued job was cancelled before processing', async () => {
    const jobId = 'b48c4704-1e9b-462a-a9d8-9adf98b1dc3e';
    vi.mocked(cancelRestore).mockResolvedValue({
      id: jobId,
      owner: 'anonymous',
      state: 'cancelled',
      result: null,
      progress: null,
    });
    const response = await request(app).delete(`/api/restore/jobs/${jobId}`);
    expect(response.status).toBe(200);
    expect(response.body.data.state).toBe('cancelled');
  });

  it('refuses to restore anonymous data when the browser expected an account session', async () => {
    const response = await request(app).post('/api/restore/jobs').send({
      jobId: 'bc89449f-0804-4d1a-810c-351c989c489b',
      expectedUserId: 'signed-in-reader',
      version: 2,
      manga: [],
      library: [],
      history: [],
    });
    expect(response.status).toBe(401);
    expect(startRestore).not.toHaveBeenCalled();
    const status = await request(app).get(
      '/api/restore/jobs/bc89449f-0804-4d1a-810c-351c989c489b?owner=signed-in-reader',
    );
    expect(status.status).toBe(401);
  });
});
