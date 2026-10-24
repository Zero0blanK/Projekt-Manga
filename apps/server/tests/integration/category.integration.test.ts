import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/configs/prisma.config.js';

describe('POST /api/category/add (real DB)', () => {
  it('400s on an empty name and creates nothing', async () => {
    const res = await request(app).post('/api/category/add').send({ category_name: '' });

    expect(res.status).toBe(400);
    expect(await prisma.category.count()).toBe(0);
  });

  it('409s on a real case-insensitive duplicate', async () => {
    await prisma.category.create({ data: { id: 'action', name: 'Action' } });

    const res = await request(app).post('/api/category/add').send({ category_name: 'action' });

    expect(res.status).toBe(409);
    expect(await prisma.category.count()).toBe(1);
  });

  it('derives the id from the name', async () => {
    const res = await request(app)
      .post('/api/category/add')
      .send({ category_name: 'Slice of Life' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('slice-of-life');
  });
});

describe('PUT /api/category/update/:category_id (real DB, real FK cascade)', () => {
  it('renaming a category cascades the id change to linked manga_category rows', async () => {
    await prisma.category.create({ data: { id: 'action', name: 'Action' } });
    const manga = await prisma.manga.create({
      data: {
        slug: 'linked-manga',
        title: 'Linked',
        author: 'x',
        source: 'mangadex',
        thumbnail_url: 'x',
      },
    });
    await prisma.manga_category.create({ data: { manga_id: manga.id, category_id: 'action' } });

    const res = await request(app)
      .put('/api/category/update/action')
      .send({ category_name: 'Action Adventure' });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('action-adventure');

    // The old id should be gone, and the link should have followed the rename via the
    // database's own ON UPDATE CASCADE rather than needing app code to fix it up.
    expect(await prisma.category.findUnique({ where: { id: 'action' } })).toBeNull();
    const link = await prisma.manga_category.findFirst({ where: { manga_id: manga.id } });
    expect(link?.category_id).toBe('action-adventure');
  });
});

describe('DELETE /api/category/delete/:category_id (real DB, real FK cascade)', () => {
  it('deleting a category removes its manga_category links too', async () => {
    await prisma.category.create({ data: { id: 'romance', name: 'Romance' } });
    const manga = await prisma.manga.create({
      data: {
        slug: 'romance-manga',
        title: 'R',
        author: 'x',
        source: 'mangadex',
        thumbnail_url: 'x',
      },
    });
    await prisma.manga_category.create({ data: { manga_id: manga.id, category_id: 'romance' } });

    const res = await request(app).delete('/api/category/delete/romance');

    expect(res.status).toBe(200);
    expect(await prisma.manga_category.findFirst({ where: { manga_id: manga.id } })).toBeNull();
    // And the manga itself is untouched — only the link was cascaded.
    expect(await prisma.manga.findUnique({ where: { id: manga.id } })).not.toBeNull();
  });
});
