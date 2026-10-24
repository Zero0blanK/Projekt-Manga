import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/configs/prisma.config.js';

async function seedManga(
  overrides: Partial<{ id: string; slug: string; title: string; source: string }> = {},
) {
  return prisma.manga.create({
    data: {
      id: overrides.id,
      slug: overrides.slug ?? `manga-${Math.random().toString(36).slice(2)}`,
      title: overrides.title ?? 'One Piece',
      author: 'Oda',
      source: overrides.source ?? 'mangadex',
      thumbnail_url: 'https://example.com/thumb.jpg',
    },
  });
}

describe('POST /api/manga/add (real DB)', () => {
  it('adds a source-only title after reading has created chapter and history rows', async () => {
    const chapterId = 'source-read-chapter';
    const source = 'source-a';
    const slug = 'read-before-add';
    const chapter = {
      id: chapterId,
      url: 'https://example.com/chapter',
      name: 'Chapter One',
      chapter_number: 1,
      page_count: 10,
    };

    const progress = await request(app)
      .post(`/api/chapter/${slug}/${chapterId}/3/mark-by-page`)
      .send({ ...chapter, source });
    expect(progress.status).toBe(200);
    const history = await request(app).post('/api/history/add').send({
      source,
      manga_slug: slug,
      source_manga_id: slug,
      title: 'Read Before Add',
      thumbnail_url: 'https://example.com/thumb.jpg',
      chapter_id: chapterId,
      pages_read: 3,
    });
    expect(history.status).toBe(201);

    const add = await request(app)
      .post('/api/manga/add')
      .send({
        source,
        title: 'Read Before Add',
        slug,
        thumbnail_url: 'https://example.com/thumb.jpg',
        description: '',
        genres: '',
        status: 'ONGOING',
        chapters: [chapter],
      });

    expect(add.status).toBe(201);
    const mangaId = add.body.data.id as string;
    expect((await prisma.chapter.findUnique({ where: { id: chapterId } }))?.manga_id).toBe(mangaId);
    expect((await prisma.history.findFirst({ where: { chapter_id: chapterId } }))?.manga_id).toBe(
      mangaId,
    );
    const library = await request(app).get('/api/manga');
    expect(library.body.data.some((manga: { id: string }) => manga.id === mangaId)).toBe(true);
  });

  it('promotes an anonymous shadow row and keeps its reading progress', async () => {
    const payload = {
      source: 'source-a',
      title: 'Anonymous Shadow Read',
      slug: 'anonymous-shadow-read',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'ONGOING',
    };
    const chapter = {
      id: 'anonymous-shadow-chapter',
      url: 'https://example.com/chapter',
      chapter_number: 1,
      page_count: 10,
    };
    const shadow = await request(app)
      .post('/api/manga/add')
      .send({ ...payload, in_library: false, chapters: [] });
    expect(shadow.status).toBe(201);
    expect(
      (
        await request(app)
          .post(`/api/chapter/${payload.slug}/${chapter.id}/3/mark-by-page`)
          .send({ ...chapter, source: payload.source })
      ).status,
    ).toBe(200);
    const added = await request(app)
      .post('/api/manga/add')
      .send({ ...payload, chapters: [chapter] });
    expect(added.status).toBe(201);
    expect(added.body.data.id).toBe(shadow.body.data.id);

    const library = await request(app).get('/api/manga');
    expect(
      library.body.data.find((manga: { id: string }) => manga.id === added.body.data.id)
        ?.chapter_count,
    ).toBe(1);
    const details = await request(app).get(`/api/manga/details/${added.body.data.id}`);
    expect(details.body.data.chapters[0].last_page_read).toBe(3);
  });

  it('lets an account add a shared title it has read but does not yet own', async () => {
    const firstAccount = request.agent(app);
    expect(
      (
        await firstAccount.post('/api/auth/register').send({
          email: 'first@example.test',
          password: 'test-password-123',
        })
      ).status,
    ).toBe(201);
    const shared = await seedManga({ slug: 'shared-read', title: 'Shared Read' });
    const reader = request.agent(app);
    const registration = await reader.post('/api/auth/register').send({
      email: 'reader@example.test',
      password: 'test-password-123',
    });
    expect(registration.status).toBe(201);
    const readerId = registration.body.data.user.id as string;
    await prisma.chapter.create({
      data: { id: 'shared-read-chapter', manga_id: shared.id, url: '', chapter_number: 1 },
    });
    await prisma.history.create({
      data: {
        source: shared.source,
        manga_slug: shared.slug,
        manga_id: shared.id,
        chapter_id: 'shared-read-chapter',
        user_id: readerId,
        pages_read: 3,
      },
    });

    const add = await reader.post('/api/manga/add').send({
      source: shared.source,
      title: shared.title,
      slug: shared.slug,
      thumbnail_url: shared.thumbnail_url,
      description: '',
      genres: '',
      status: 'ONGOING',
      chapters: [{ id: 'shared-read-chapter', url: '', chapter_number: 1 }],
    });

    expect(add.status).toBe(201);
    expect(add.body.data.in_library).toBe(true);
    const library = await reader.get('/api/manga');
    expect(library.body.data.some((manga: { id: string }) => manga.id === shared.id)).toBe(true);
    expect(
      library.body.data.find((manga: { id: string }) => manga.id === shared.id)?.in_library,
    ).toBe(true);
    const duplicate = await reader.post('/api/manga/add').send({
      source: shared.source,
      title: shared.title,
      slug: shared.slug,
      thumbnail_url: shared.thumbnail_url,
      description: '',
      genres: '',
      status: 'ONGOING',
      chapters: [],
    });
    expect(duplicate.status).toBe(409);
  });

  it('attaches source-only account progress when promoting an existing shadow row', async () => {
    const reader = request.agent(app);
    expect(
      (
        await reader.post('/api/auth/register').send({
          email: 'shadow-reader@example.test',
          password: 'test-password-123',
        })
      ).status,
    ).toBe(201);
    const source = 'source-a';
    const slug = 'shadow-read';
    const chapter = {
      id: 'shadow-chapter',
      url: 'https://example.com/chapter',
      chapter_number: 1,
      page_count: 10,
    };
    const payload = {
      source,
      title: 'Shadow Read',
      slug,
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'ONGOING',
    };

    const shadow = await reader
      .post('/api/manga/add')
      .send({ ...payload, in_library: false, chapters: [] });
    expect(shadow.status).toBe(201);
    expect(
      (
        await reader
          .post(`/api/chapter/${slug}/${chapter.id}/3/mark-by-page`)
          .send({ ...chapter, source })
      ).status,
    ).toBe(200);
    const add = await reader.post('/api/manga/add').send({ ...payload, chapters: [chapter] });
    expect(add.status).toBe(201);
    expect(add.body.data.in_library).toBe(true);
    expect((await prisma.chapter.findUnique({ where: { id: chapter.id } }))?.manga_id).toBe(
      shadow.body.data.id,
    );
    const details = await reader.get(`/api/manga/details/${shadow.body.data.id}`);
    expect(details.body.data.in_library).toBe(true);
    expect(details.body.data.chapters[0].last_page_read).toBe(3);
    expect((await request(app).get('/api/manga')).body.data).toEqual([]);
  });

  it('persists a manga with its detail row', async () => {
    const res = await request(app).post('/api/manga/add').send({
      source: 'mangadex',
      title: 'Real Manga',
      slug: 'real-manga',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: 'A real description',
      genres: 'Action, Adventure',
      status: 'ONGOING',
      chapters: [],
    });

    expect(res.status).toBe(201);

    const stored = await prisma.manga.findUnique({
      where: { source_slug: { source: 'mangadex', slug: 'real-manga' } },
      include: { manga_detail: true },
    });
    expect(stored?.title).toBe('Real Manga');
    expect(stored?.manga_detail?.status).toBe('ONGOING');
  });

  it('409s on a real unique-constraint collision (duplicate slug)', async () => {
    await seedManga({ slug: 'dup-slug', title: 'First' });

    const res = await request(app).post('/api/manga/add').send({
      source: 'mangadex',
      title: 'Second',
      slug: 'dup-slug',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'ONGOING',
      chapters: [],
    });

    expect(res.status).toBe(409);
  });

  it('allows the same slug from different sources', async () => {
    await seedManga({ source: 'first-source', slug: 'shared-slug', title: 'First' });

    const res = await request(app).post('/api/manga/add').send({
      source: 'second-source',
      title: 'Second',
      slug: 'shared-slug',
      thumbnail_url: 'https://example.com/thumb.jpg',
      description: '',
      genres: '',
      status: 'ONGOING',
      chapters: [],
    });

    expect(res.status).toBe(201);
    expect(await prisma.manga.count({ where: { slug: 'shared-slug' } })).toBe(2);
  });
});

describe('DELETE /api/manga/:manga_id/delete (real DB, real cascades)', () => {
  it('404s and leaves every row untouched when the id does not match anything', async () => {
    // This is the concrete regression test for the fixed data-loss bug: with an
    // unmatched id and the old code, this would have deleted/detached every manga's
    // rows because `manga_id: undefined` in a Prisma where-clause matches everything.
    const untouched = await seedManga({ slug: 'untouched', title: 'Untouched' });
    await prisma.manga_detail.create({
      data: {
        manga_id: untouched.id,
        artist: 'x',
        description: 'x',
        genres: 'x',
        status: 'ONGOING',
      },
    });
    await prisma.chapter.create({
      data: { id: 'ch-untouched', manga_id: untouched.id, url: 'x', chapter_number: 1 },
    });

    const res = await request(app).delete('/api/manga/does-not-exist/delete');
    expect(res.status).toBe(404);

    expect(await prisma.manga.count()).toBe(1);
    expect(await prisma.manga_detail.count()).toBe(1);
    expect(await prisma.chapter.count()).toBe(1);
  });

  it('deletes the manga, its detail row, and its unread chapters when there is no history', async () => {
    const manga = await seedManga({ slug: 'to-delete' });
    await prisma.manga_detail.create({
      data: { manga_id: manga.id, artist: 'x', description: 'x', genres: 'x', status: 'ONGOING' },
    });
    await prisma.chapter.create({
      data: { id: 'ch-1', manga_id: manga.id, url: 'x', chapter_number: 1 },
    });

    const res = await request(app).delete(`/api/manga/${manga.id}/delete`);
    expect(res.status).toBe(200);

    expect(await prisma.manga.findUnique({ where: { id: manga.id } })).toBeNull();
    expect(await prisma.manga_detail.findUnique({ where: { manga_id: manga.id } })).toBeNull();
    expect(await prisma.chapter.findUnique({ where: { id: 'ch-1' } })).toBeNull();
  });

  it('detaches (does not delete) chapters/history that have real read history', async () => {
    const manga = await seedManga({ slug: 'has-history' });
    await prisma.chapter.create({
      data: { id: 'ch-h1', manga_id: manga.id, url: 'x', chapter_number: 1 },
    });
    await prisma.history.create({
      data: {
        source: 'mangadex',
        manga_id: manga.id,
        manga_slug: manga.slug,
        chapter_id: 'ch-h1',
        pages_read: 1,
      },
    });

    const res = await request(app).delete(`/api/manga/${manga.id}/delete`);
    expect(res.status).toBe(200);

    const chapter = await prisma.chapter.findUnique({ where: { id: 'ch-h1' } });
    expect(chapter).not.toBeNull();
    expect(chapter?.manga_id).toBeNull();

    const history = await prisma.history.findFirst({ where: { chapter_id: 'ch-h1' } });
    expect(history?.manga_id).toBeNull();
  });

  it('leaves unrelated manga alone when deleting one of several', async () => {
    const target = await seedManga({ slug: 'target' });
    await seedManga({ slug: 'sibling-a' });
    await seedManga({ slug: 'sibling-b' });

    const res = await request(app).delete(`/api/manga/${target.id}/delete`);
    expect(res.status).toBe(200);

    expect(await prisma.manga.count()).toBe(2);
  });
});

describe('GET /api/manga (real DB)', () => {
  it('computes chapter_count/unread_count from real rows', async () => {
    const manga = await seedManga({ slug: 'counted' });
    await prisma.chapter.create({
      data: { id: 'c1', manga_id: manga.id, url: 'x', chapter_number: 1, is_read: true },
    });
    await prisma.chapter.create({
      data: { id: 'c2', manga_id: manga.id, url: 'x', chapter_number: 2, is_read: false },
    });

    const res = await request(app).get('/api/manga');

    expect(res.status).toBe(200);
    const row = res.body.data.find((m: { id: string }) => m.id === manga.id);
    expect(row.chapter_count).toBe(2);
    expect(row.unread_count).toBe(1);
  });
});
