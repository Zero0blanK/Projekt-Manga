import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadSummary } from '@projekt-manga/api-client';

const api = vi.hoisted(() => ({
  getDownloadedChapterPages: vi.fn(),
  getMangaChapters: vi.fn(),
  getMangaLinks: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  ...api,
}));

const download = (chapter: string, status = 'COMPLETED', manga = 'm1') =>
  ({
    id: `d-${chapter}`,
    manga_id: manga,
    chapter_id: chapter,
    source_chapter_key: chapter,
    source_id: 'src',
    mangaSlug: `${manga}-slug`,
    status,
    chapterNumber: 1,
  }) as DownloadSummary;

let messages: Array<{ kind: string; urls: string[] }>;

beforeEach(() => {
  vi.resetModules();
  messages = [];
  api.getDownloadedChapterPages.mockReset().mockResolvedValue([{ index: 1 }, { index: 2 }]);
  api.getMangaChapters.mockReset().mockResolvedValue([]);
  api.getMangaLinks.mockReset().mockResolvedValue([]);
  const active = {
    postMessage: (data: { kind: string; urls: string[] }, ports: MessagePort[]) => {
      messages.push({ kind: data.kind, urls: data.urls });
      ports[0].postMessage('done');
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ active }) },
  });
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      estimate: async () => ({ usage: 10, quota: 1000 }),
      persist: async () => true,
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(navigator, 'storage');
});

const run = async (downloads: DownloadSummary[]) => {
  const { keepDownloadsOffline } = await import('@/lib/offline-downloads');
  await keepDownloadsOffline(downloads);
  return keepDownloadsOffline;
};

describe('keeping downloads for offline reading', () => {
  it("keeps each completed chapter's pages, and its title's pages once", async () => {
    await run([download('c1'), download('c2'), download('c3', 'QUEUED')]);

    const pages = messages.filter((m) => m.kind === 'pages');
    expect(pages).toHaveLength(1);
    expect(pages[0].urls.map((u) => new URL(u).pathname)).toEqual(['/manga/m1', '/reader/m1']);
    const chapters = messages.filter((m) => m.kind === 'chapters').flatMap((m) => m.urls);
    expect(chapters.map((u) => new URL(u).pathname)).toEqual([
      '/api/downloads/chapter/c1/page/1',
      '/api/downloads/chapter/c1/page/2',
      '/api/downloads/chapter/c2/page/1',
      '/api/downloads/chapter/c2/page/2',
    ]);
    // The chapter list is asked for as the reader asks, so the worker keeps it.
    expect(api.getMangaChapters).toHaveBeenCalledWith('m1', 'm1-slug', 'src');
  });

  it('keeps a chapter once per page load, and tries a failed one again', async () => {
    api.getDownloadedChapterPages.mockRejectedValueOnce(new Error('offline'));
    const keep = await run([download('c1')]);
    expect(messages.filter((m) => m.kind === 'chapters')).toHaveLength(0);

    await keep([download('c1')]);
    await keep([download('c1')]);
    expect(messages.filter((m) => m.kind === 'chapters')).toHaveLength(1);
  });

  it('ignores anything that is not the downloads list', async () => {
    // The statistics' download totals share the downloads query prefix.
    await run({ total: 2, completed: 2 } as unknown as DownloadSummary[]);
    expect(messages).toHaveLength(0);
  });

  it('stops when the device is nearly out of room', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ usage: 900, quota: 1000 }), persist: async () => true },
    });
    await run([download('c1')]);
    expect(messages).toHaveLength(0);
  });
});
