import { describe, it, expect, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { fetchJsonHtmlBrowse, type JsonHtmlBrowseResponse } from '../utils/jsonHtmlBrowse.js';

function fakeAxios(
  handler: (params: Record<string, unknown>) => JsonHtmlBrowseResponse,
): AxiosInstance {
  return {
    get: vi.fn(async (_endpoint: string, config?: { params?: Record<string, unknown> }) => ({
      data: handler(config?.params || {}),
    })),
  } as unknown as AxiosInstance;
}

function cardsHtml(labels: string[]): string {
  return labels.map((label) => `<div class="card">${label}</div>`).join('');
}

describe('fetchJsonHtmlBrowse', () => {
  it('parses items from results_html and slices by limit/offset within one page', async () => {
    const api = fakeAxios(() => ({
      results_html: cardsHtml(['a', 'b', 'c', 'd']),
      page: 1,
      num_pages: 1,
    }));

    const items = await fetchJsonHtmlBrowse(
      {
        sourceId: 'test-source',
        cacheKeyPrefix: 'test-one-page',
        api,
        endpoint: '/browse',
        itemSelector: '.card',
        sitePageSize: 24,
        buildParams: (page) => ({ page }),
        mapItem: (node) => node.text(),
      },
      { limit: 2, offset: 1 },
    );

    expect(items).toEqual(['b', 'c']);
  });

  it('fetches a second site-page when the first page cannot satisfy the limit', async () => {
    const pages: Record<number, string[]> = { 1: ['a', 'b'], 2: ['c', 'd'] };

    const api = fakeAxios((params) => ({
      results_html: cardsHtml(pages[Number(params.page)] || []),
      page: Number(params.page),
      num_pages: 2,
    }));

    const items = await fetchJsonHtmlBrowse(
      {
        sourceId: 'test-source',
        cacheKeyPrefix: 'test-two-pages',
        api,
        endpoint: '/browse',
        itemSelector: '.card',
        sitePageSize: 2,
        buildParams: (page) => ({ page }),
        mapItem: (node) => node.text(),
      },
      { limit: 3, offset: 1 },
    );

    expect(items).toEqual(['b', 'c', 'd']);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('stops paginating once a page returns zero items, even if more limit remains', async () => {
    const api = fakeAxios((params) => {
      const page = Number(params.page);
      return {
        results_html: page === 1 ? cardsHtml(['a']) : '',
        page,
        num_pages: 5,
      };
    });

    const items = await fetchJsonHtmlBrowse(
      {
        sourceId: 'test-source',
        cacheKeyPrefix: 'test-early-stop',
        api,
        endpoint: '/browse',
        itemSelector: '.card',
        sitePageSize: 1,
        buildParams: (page) => ({ page }),
        mapItem: (node) => node.text(),
      },
      { limit: 10, offset: 0 },
    );

    expect(items).toEqual(['a']);
  });

  it('falls back to the requested page number as numPages when the API omits a valid num_pages', async () => {
    const api = fakeAxios(() => ({
      results_html: cardsHtml(['only-item']),
      page: 1,
      num_pages: 0,
    }));

    const items = await fetchJsonHtmlBrowse(
      {
        sourceId: 'test-source',
        cacheKeyPrefix: 'test-fallback-numpages',
        api,
        endpoint: '/browse',
        itemSelector: '.card',
        sitePageSize: 1,
        buildParams: (page) => ({ page }),
        mapItem: (node) => node.text(),
      },
      { limit: 5, offset: 0 },
    );

    // num_pages: 0 isn't a valid page count, so numPages falls back to the current page
    // (1) — the pagination loop correctly stops there instead of requesting a page 2 that
    // was never promised to exist.
    expect(items).toEqual(['only-item']);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array immediately when limit is 0, without fetching', async () => {
    const api = fakeAxios(() => ({ results_html: cardsHtml(['a']), page: 1, num_pages: 1 }));

    const items = await fetchJsonHtmlBrowse(
      {
        sourceId: 'test-source',
        cacheKeyPrefix: 'test-zero-limit',
        api,
        endpoint: '/browse',
        itemSelector: '.card',
        sitePageSize: 24,
        buildParams: (page) => ({ page }),
        mapItem: (node) => node.text(),
      },
      { limit: 0, offset: 0 },
    );

    expect(items).toEqual([]);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('mapItem returning null for an element drops it from the results', async () => {
    const api = fakeAxios(() => ({
      results_html: cardsHtml(['keep', 'skip', 'keep-too']),
      page: 1,
      num_pages: 1,
    }));

    const items = await fetchJsonHtmlBrowse(
      {
        sourceId: 'test-source',
        cacheKeyPrefix: 'test-null-filter',
        api,
        endpoint: '/browse',
        itemSelector: '.card',
        sitePageSize: 24,
        buildParams: (page) => ({ page }),
        mapItem: (node) => (node.text() === 'skip' ? null : node.text()),
      },
      { limit: 10, offset: 0 },
    );

    expect(items).toEqual(['keep', 'keep-too']);
  });
});
