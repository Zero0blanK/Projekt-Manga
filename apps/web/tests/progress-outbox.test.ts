import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addHistory,
  flushProgressOutbox,
  getChapter,
  markChapterByLastPage,
  markChapterAsRead,
  pendingProgressWrites,
  setProgressOutboxStore,
  type PendingWrite,
} from '@projekt-manga/api-client';

let rows: PendingWrite[];
let who: string | null;
const fetchMock = vi.fn();

const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const refused = () =>
  new Response(JSON.stringify({ success: false, message: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });

const meta = { source: 'src' };
const history = (pages: number, time: number) => ({
  source: 'src',
  manga_slug: 'one',
  source_chapter_key: 'c1',
  pages_read: pages,
  time_read: time,
});

beforeEach(() => {
  rows = [];
  who = 'u1';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setProgressOutboxStore({
    read: () => rows.map((row) => ({ ...row })),
    write: (next) => {
      rows = next;
    },
    owner: () => who,
  });
});

afterEach(() => {
  setProgressOutboxStore(null);
  vi.unstubAllGlobals();
});

describe('reading progress with no connection', () => {
  it('is kept on this device instead of failing', async () => {
    fetchMock.mockImplementation(offline);
    await expect(markChapterByLastPage('one', 'c1', 5, meta)).resolves.toEqual({ count: 1 });
    expect(pendingProgressWrites()).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: 'u1', key: 'chapter:one:c1' });
  });

  it('keeps only where the reader is now, for each chapter', async () => {
    fetchMock.mockImplementation(offline);
    await markChapterByLastPage('one', 'c1', 3, meta);
    await markChapterByLastPage('one', 'c1', 9, meta);
    await markChapterAsRead('one', 'c2', meta);
    expect(rows.map((r) => r.path)).toEqual([
      '/chapter/one/c1/9/mark-by-page',
      '/chapter/one/c2/mark-read',
    ]);
  });

  it('adds up reading time across history writes for a chapter', async () => {
    fetchMock.mockImplementation(offline);
    await addHistory(history(3, 40));
    await addHistory(history(9, 25));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatchObject({ pages_read: 9, time_read: 65 });
  });

  it('still fails a write the server refused, rather than keeping it', async () => {
    fetchMock.mockImplementation(async () => refused());
    await expect(markChapterByLastPage('one', 'c1', 5, meta)).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });

  it("isn't kept when it isn't known whose it is", async () => {
    who = null;
    fetchMock.mockImplementation(offline);
    await expect(markChapterByLastPage('one', 'c1', 5, meta)).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });

  it('shows in the chapter list before the server has it', async () => {
    fetchMock.mockImplementation(offline);
    await markChapterByLastPage('one', 'c1', 7, meta);
    await markChapterAsRead('one', 'c2', meta);
    fetchMock.mockImplementation(async () =>
      ok([
        { source_chapter_key: 'c1', last_page_read: 0, is_read: false },
        { source_chapter_key: 'c2', last_page_read: 0, is_read: false },
        { source_chapter_key: 'c3', last_page_read: 2, is_read: false },
      ]),
    );
    const chapters = await getChapter('one', undefined, 'src');
    expect(chapters.map((c) => [c.source_chapter_key, c.last_page_read, c.is_read])).toEqual([
      ['c1', 7, false],
      ['c2', 0, true],
      ['c3', 2, false],
    ]);
  });

  it('a later write that reaches the server replaces the one kept', async () => {
    fetchMock.mockImplementation(offline);
    await markChapterByLastPage('one', 'c1', 3, meta);
    fetchMock.mockImplementation(async () => ok({ count: 1 }));
    await markChapterByLastPage('one', 'c1', 4, meta);
    expect(rows).toHaveLength(0);
  });
});

describe('sending what was kept', () => {
  it('sends it oldest first once the server answers', async () => {
    fetchMock.mockImplementation(offline);
    await markChapterByLastPage('one', 'c1', 3, meta);
    await markChapterAsRead('one', 'c2', meta);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ok({ count: 1 }));

    await expect(flushProgressOutbox()).resolves.toEqual({ sent: 2, remaining: 0 });
    const sent = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(sent).toEqual(['/api/chapter/one/c1/3/mark-by-page', '/api/chapter/one/c2/mark-read']);
    expect(rows).toHaveLength(0);
  });

  it("stops while the server still can't be reached, keeping the rest", async () => {
    fetchMock.mockImplementation(offline);
    await markChapterByLastPage('one', 'c1', 3, meta);
    await markChapterAsRead('one', 'c2', meta);
    await expect(flushProgressOutbox()).resolves.toEqual({ sent: 0, remaining: 2 });
  });

  it('drops a write the server refuses, so it is not resent forever', async () => {
    fetchMock.mockImplementation(offline);
    await markChapterByLastPage('one', 'c1', 3, meta);
    fetchMock.mockImplementation(async () => refused());
    await expect(flushProgressOutbox()).resolves.toEqual({ sent: 0, remaining: 0 });
  });

  it("sends only the signed-in account's progress", async () => {
    fetchMock.mockImplementation(offline);
    await markChapterByLastPage('one', 'c1', 3, meta);
    who = 'u2';
    fetchMock.mockImplementation(async () => ok({ count: 1 }));
    await expect(flushProgressOutbox()).resolves.toEqual({ sent: 0, remaining: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe('u1');
  });
});
