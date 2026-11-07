import { describe, expect, it, vi } from 'vitest';
import { fetchAllPages } from '@projekt-manga/api-client';

describe('fetchAllPages', () => {
  it('walks the list until a page comes back short', async () => {
    const pages = [Array(200).fill('a'), Array(200).fill('b'), ['c']];
    const fetchPage = vi.fn(async ({ offset }: { limit: number; offset: number }) => {
      return pages[offset / 200];
    });

    const all = await fetchAllPages(fetchPage);

    expect(all).toHaveLength(401);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([
      { limit: 200, offset: 0 },
      { limit: 200, offset: 200 },
      { limit: 200, offset: 400 },
    ]);
  });

  it('stops after one request for a short list', async () => {
    const fetchPage = vi.fn(async () => ['only']);

    expect(await fetchAllPages(fetchPage)).toEqual(['only']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('passes a failed page on', async () => {
    await expect(fetchAllPages(() => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline',
    );
  });
});
