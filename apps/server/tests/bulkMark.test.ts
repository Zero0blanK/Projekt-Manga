import { describe, it, expect } from 'vitest';
import { prismaMock } from './mocks/prismaMock.js';
import chapterService from '../src/services/chapter.service.js';

const stored = (key: string) => ({
  id: `row-${key}`,
  source_chapter_key: key,
  chapter_number: 1,
  manga_id: 'manga-1',
});
const chapters = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    source: 'src',
    chapter_number: index + 1,
    page_count: 10,
  }));

function mockTitle(rows: Array<ReturnType<typeof stored>>) {
  prismaMock.manga.findFirst.mockResolvedValue({ id: 'manga-1' });
  prismaMock.chapter.findMany.mockResolvedValue(rows);
  prismaMock.history.findMany.mockResolvedValue([]);
  prismaMock.history.createMany.mockResolvedValue({ count: rows.length });
}

describe('marking many chapters at once', () => {
  it('writes a whole title in a few statements, not several per chapter', async () => {
    const list = chapters(50);
    mockTitle(list.map(({ id }) => stored(id)));
    prismaMock.user_chapter_state.findMany.mockResolvedValue([]);

    const result = await chapterService.markPreviousChaptersAsRead(
      'slug',
      list,
      undefined,
      'user-1',
    );

    expect(result).toEqual({ count: 50, failed_source_chapter_keys: [] });
    expect(prismaMock.chapter.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.user_chapter_state.upsert).not.toHaveBeenCalled();
    expect(prismaMock.user_chapter_state.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.history.createMany).toHaveBeenCalledTimes(1);
  });

  it('updates history already there and creates what is missing', async () => {
    const list = chapters(2);
    mockTitle(list.map(({ id }) => stored(id)));
    prismaMock.chapter.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.history.findMany.mockResolvedValue([
      { id: 'h0', chapter_id: 'row-c0', sync_updated_at: null },
    ]);

    await chapterService.markPreviousChaptersAsRead('slug', list);

    expect(prismaMock.history.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['h0'] } },
        data: expect.objectContaining({ pages_read: 10, deleted_at: null }),
      }),
    );
    expect(prismaMock.history.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(prismaMock.history.createMany.mock.calls[0][0].data[0]).toMatchObject({
      chapter_id: 'row-c1',
      pages_read: 10,
      user_id: null,
    });
  });

  it('marks unread by clearing the saved page', async () => {
    const list = chapters(2);
    mockTitle(list.map(({ id }) => stored(id)));
    prismaMock.user_chapter_state.findMany.mockResolvedValue([]);

    await chapterService.markPreviousChaptersAsUnread('slug', list, undefined, 'user-1');

    expect(prismaMock.user_chapter_state.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', chapter_id: { in: ['row-c0', 'row-c1'] } },
      data: { is_read: false, last_page_read: 0 },
    });
  });

  it('reports the slice that failed and keeps the ones that worked', async () => {
    const list = chapters(250);
    mockTitle(list.map(({ id }) => stored(id)));
    prismaMock.chapter.updateMany
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue({ count: 50 });

    const result = await chapterService.markPreviousChaptersAsRead('slug', list);

    expect(result?.count).toBe(50);
    expect(result?.failed_source_chapter_keys).toHaveLength(200);
  });

  it('falls back to resolving a chapter this server has not stored', async () => {
    mockTitle([]);
    prismaMock.manga.findUnique.mockResolvedValue({ id: 'manga-1' });
    prismaMock.chapter.findUnique.mockResolvedValue(null);
    prismaMock.chapter.create.mockResolvedValue(stored('c0'));
    prismaMock.chapter.updateMany.mockResolvedValue({ count: 1 });

    const result = await chapterService.markPreviousChaptersAsRead('slug', chapters(1));

    expect(prismaMock.chapter.create).toHaveBeenCalledTimes(1);
    expect(result?.count).toBe(1);
  });
});
