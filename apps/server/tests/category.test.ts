import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';

const now = new Date();
const sampleCategory = { id: 'action', name: 'Action', created_at: now, updated_at: now };

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
    prismaMock.category.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/category/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('200s with the category when found', async () => {
    prismaMock.category.findUnique.mockResolvedValueOnce(sampleCategory);

    const res = await request(app).get('/api/category/action');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('action');
  });
});

describe('POST /api/category/add', () => {
  it('400s on an empty name without ever checking for duplicates', async () => {
    const res = await request(app).post('/api/category/add').send({ category_name: '' });

    expect(res.status).toBe(400);
    expect(prismaMock.category.findMany).not.toHaveBeenCalled();
  });

  it('400s on a missing name field (not a 500 crash)', async () => {
    const res = await request(app).post('/api/category/add').send({});

    expect(res.status).toBe(400);
  });

  it('409s on a case-insensitive duplicate name', async () => {
    prismaMock.category.findMany.mockResolvedValueOnce([sampleCategory]);

    const res = await request(app).post('/api/category/add').send({ category_name: 'action' });

    expect(res.status).toBe(409);
    expect(prismaMock.category.create).not.toHaveBeenCalled();
  });

  it('201s and creates the category on a valid, unique name', async () => {
    prismaMock.category.findMany.mockResolvedValueOnce([]);
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
    prismaMock.category.findMany.mockResolvedValueOnce([sampleCategory]);
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
});

describe('DELETE /api/category/delete/:category_id', () => {
  it('200s on delete', async () => {
    prismaMock.category.delete.mockResolvedValueOnce(sampleCategory);

    const res = await request(app).delete('/api/category/delete/action');

    expect(res.status).toBe(200);
  });
});
