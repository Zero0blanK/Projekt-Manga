import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

const now = new Date();
const sampleCategory = {
  id: 'action',
  user_id: null,
  name: 'Action',
  key: 'action',
  created_at: now,
  updated_at: now,
};

describe('GET /api/category', () => {
  it('returns the category list', async () => {
    prismaMock.category.findMany.mockResolvedValueOnce([sampleCategory]);

    const res = await request(app).get('/api/category');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('action');
  });
});

describe('GET /api/category/:category_id', () => {
  it('404s when the category does not exist', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/category/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('200s with the category when found', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(sampleCategory);

    const res = await request(app).get('/api/category/action');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('action');
  });
});

describe('POST /api/category/add', () => {
  it('400s on an empty name without ever checking for duplicates', async () => {
    const res = await request(app).post('/api/category/add').send({ category_name: '' });

    expect(res.status).toBe(400);
    expect(prismaMock.category.findFirst).not.toHaveBeenCalled();
  });

  it('400s on a missing name field (not a 500 crash)', async () => {
    const res = await request(app).post('/api/category/add').send({});

    expect(res.status).toBe(400);
  });

  it('409s on a case-insensitive duplicate name', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(sampleCategory);

    const res = await request(app).post('/api/category/add').send({ category_name: 'action' });

    expect(res.status).toBe(409);
    expect(prismaMock.category.create).not.toHaveBeenCalled();
  });

  it('201s and creates the category on a valid, unique name', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(null);
    prismaMock.category.create.mockResolvedValueOnce({
      id: 'romance',
      name: 'Romance',
      created_at: now,
      updated_at: now,
    });

    const res = await request(app).post('/api/category/add').send({ category_name: 'Romance' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('romance');
  });
});

describe('PUT /api/category/update/:category_id', () => {
  it('400s on an empty name', async () => {
    const res = await request(app).put('/api/category/update/action').send({ category_name: '' });

    expect(res.status).toBe(400);
  });

  it('updates on a valid name', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(sampleCategory);
    prismaMock.category.findFirst.mockResolvedValueOnce(null);
    prismaMock.category.update.mockResolvedValueOnce({
      ...sampleCategory,
      name: 'Action & Adventure',
    });

    const res = await request(app)
      .put('/api/category/update/action')
      .send({ category_name: 'Action & Adventure' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Action & Adventure');
  });

  it('lets a rename change only the case', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(sampleCategory);
    prismaMock.category.findFirst.mockResolvedValueOnce(sampleCategory);
    prismaMock.category.update.mockResolvedValueOnce({ ...sampleCategory, name: 'ACTION' });

    const res = await request(app)
      .put('/api/category/update/action')
      .send({ category_name: 'ACTION' });

    expect(res.status).toBe(200);
  });

  it("404s on another identity's category without changing it", async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .put('/api/category/update/someone-elses')
      .send({ category_name: 'Mine now' });

    expect(res.status).toBe(404);
    expect(prismaMock.category.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/category/delete/:category_id', () => {
  it('200s on delete', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(sampleCategory);
    prismaMock.category.delete.mockResolvedValueOnce(sampleCategory);

    const res = await request(app).delete('/api/category/delete/action');

    expect(res.status).toBe(200);
  });

  it("404s on another identity's category without deleting it", async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(null);

    const res = await request(app).delete('/api/category/delete/someone-elses');

    expect(res.status).toBe(404);
    expect(prismaMock.category.delete).not.toHaveBeenCalled();
  });
});

describe('GET /api/category/state', () => {
  it('returns each anonymous category with its titles', async () => {
    prismaMock.category.findMany.mockResolvedValueOnce([sampleCategory]);
    prismaMock.manga_category.findMany.mockResolvedValueOnce([
      { manga_id: 'm-1', category_id: 'action' },
    ]);

    const res = await request(app).get('/api/category/state');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'action', name: 'Action', manga_ids: ['m-1'] }]);
    expect(prismaMock.category.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: null } }),
    );
  });
});

describe('PUT and DELETE /api/category/:category_id/manga/:manga_id', () => {
  it('adds a title to an owned category', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(sampleCategory);
    prismaMock.manga.findFirst.mockResolvedValueOnce({ id: 'm-1' });

    const res = await request(app).put('/api/category/action/manga/m-1');

    expect(res.status).toBe(200);
    expect(prismaMock.manga_category.upsert).toHaveBeenCalled();
  });

  it('removes a title from an owned category', async () => {
    prismaMock.category.findFirst.mockResolvedValueOnce(sampleCategory);

    const res = await request(app).delete('/api/category/action/manga/m-1');

    expect(res.status).toBe(200);
    expect(prismaMock.manga_category.deleteMany).toHaveBeenCalledWith({
      where: { manga_id: 'm-1', category_id: 'action' },
    });
  });
});

describe('POST /api/category/import', () => {
  it('reuses existing names and skips unknown titles', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([{ id: 'm-1' }]);
    prismaMock.category.findFirst.mockResolvedValue(sampleCategory);
    prismaMock.manga.findFirst.mockResolvedValue({ id: 'm-1' });

    const res = await request(app)
      .post('/api/category/import')
      .send({ categories: [{ name: 'Action', manga_ids: ['m-1', 'gone'] }] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ categories: 1, assignments: 1 });
    expect(prismaMock.category.create).not.toHaveBeenCalled();
  });
});
