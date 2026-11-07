import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import mangaRepository from '../src/repositories/manga.repository.js';

const row = (id: string) => ({
  id,
  _count: { chapter: 0 },
  chapter: [],
  manga_detail: null,
  title: id,
  author: 'a',
});

describe('GET /api/manga paging', () => {
  it('passes limit and offset through, with a stable order', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([row('m1')]);
    prismaMock.chapter.groupBy.mockResolvedValueOnce([]);
    prismaMock.manga_override.findMany.mockResolvedValueOnce([]);

    const res = await request(app).get('/api/manga?limit=1&offset=2&sortBy=title');

    expect(res.status).toBe(200);
    expect(prismaMock.manga.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        skip: 2,
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('still answers with everything when no page is asked for', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([]);

    await request(app).get('/api/manga');

    const query = prismaMock.manga.findMany.mock.calls[0][0];
    expect(query).not.toHaveProperty('take');
    expect(query).not.toHaveProperty('skip');
  });

  it('refuses a page larger than the limit', async () => {
    const res = await request(app).get('/api/manga?limit=100000');

    expect(res.status).toBe(400);
  });
});

describe('getMangaDetailsByIds', () => {
  const stored = (id: string) => ({
    id,
    title: id,
    author: 'a',
    manga_detail: null,
    cache: null,
    chapter: [{ id: `${id}-c1`, is_read: true, is_bookmark: true, last_page_read: 9 }],
  });

  it('reads many titles in one query, in the order asked, without the missing one', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([stored('b'), stored('a')]);
    prismaMock.manga_override.findMany.mockResolvedValueOnce([]);

    const rows = await mangaRepository.getMangaDetailsByIds(['a', 'gone', 'b']);

    expect(rows.map((manga) => manga.id)).toEqual(['a', 'b']);
    expect(prismaMock.manga.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.manga.findUnique).not.toHaveBeenCalled();
  });

  it("overlays an account's own state instead of the shared columns", async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([stored('a')]);
    prismaMock.user_library.findMany.mockResolvedValueOnce([{ manga_id: 'a' }]);
    prismaMock.user_chapter_state.findMany.mockResolvedValueOnce([]);
    prismaMock.manga_override.findMany.mockResolvedValueOnce([]);

    const [manga] = await mangaRepository.getMangaDetailsByIds(['a'], 'user-1');

    expect(manga.in_library).toBe(true);
    expect(manga.chapter[0]).toMatchObject({
      is_read: false,
      is_bookmark: false,
      last_page_read: 0,
    });
  });
});
