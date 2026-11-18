import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@projekt-manga/api-client';

const api = vi.hoisted(() => ({
  getSourceMangaDetails: vi.fn(),
  getSources: vi.fn(),
}));

vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  ...api,
}));

import { fetchSourceTitle } from '@/lib/source-title';

const httpError = (status: number, message = `Request failed with status ${status}`) =>
  new ApiError(message, status, 'http');

describe('fetchSourceTitle', () => {
  beforeEach(() => {
    api.getSourceMangaDetails.mockReset();
    api.getSources.mockReset();
  });

  it('returns the details when the source has the title', async () => {
    api.getSourceMangaDetails.mockResolvedValue({ id: 'm1', title: 'A title' });
    await expect(fetchSourceTitle('src', 'm1')).resolves.toEqual({
      status: 'found',
      details: { id: 'm1', title: 'A title' },
    });
    expect(api.getSources).not.toHaveBeenCalled();
  });

  it('says the title is missing when the source answers 404', async () => {
    api.getSourceMangaDetails.mockRejectedValue(httpError(404));
    await expect(fetchSourceTitle('src', 'm1')).resolves.toEqual({ status: 'missing-title' });
  });

  it("says the source is missing when it isn't installed", async () => {
    api.getSourceMangaDetails.mockRejectedValue(httpError(503, 'Source not found: gone'));
    api.getSources.mockResolvedValue([{ id: 'other' }]);
    await expect(fetchSourceTitle('gone', 'm1')).resolves.toEqual({ status: 'missing-source' });
  });

  it('rethrows when an installed source fails, for the error page', async () => {
    const failure = httpError(503, 'The source is down');
    api.getSourceMangaDetails.mockRejectedValue(failure);
    api.getSources.mockResolvedValue([{ id: 'src' }]);
    await expect(fetchSourceTitle('src', 'm1')).rejects.toBe(failure);
  });

  it("rethrows when it can't tell whether the source is installed", async () => {
    const failure = httpError(503);
    api.getSourceMangaDetails.mockRejectedValue(failure);
    api.getSources.mockRejectedValue(new ApiError('down', 0, 'network'));
    await expect(fetchSourceTitle('src', 'm1')).rejects.toBe(failure);
  });

  it("doesn't ask for the sources when the server can't be reached", async () => {
    const failure = new ApiError('down', 0, 'network');
    api.getSourceMangaDetails.mockRejectedValue(failure);
    await expect(fetchSourceTitle('src', 'm1')).rejects.toBe(failure);
    expect(api.getSources).not.toHaveBeenCalled();
  });
});
