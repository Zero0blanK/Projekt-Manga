import { describe, expect, it } from 'vitest';
import request from 'supertest';
import prisma from '../../src/configs/prisma.config.js';
import app from '../../src/app.js';
import mangaRepository from '../../src/repositories/manga.repository.js';
import mangaOverrideRepository from '../../src/repositories/mangaOverride.repository.js';
import mangaService from '../../src/services/manga.service.js';
import { replaceBackup } from '../../src/repositories/restore.repository.js';
import { replaceBackupBodySchema } from '@projekt-manga/schemas';

const seedManga = async (slug = 'edited-title') => {
  const manga = await prisma.manga.create({
    data: {
      source: 'test-source',
      slug,
      title: 'Source Title',
      author: 'Source Author',
      thumbnail_url: 'https://example.com/cover.jpg',
    },
  });
  await prisma.manga_detail.create({
    data: {
      manga_id: manga.id,
      artist: 'Artist',
      description: 'Source description',
      genres: 'Action',
      status: 'ONGOING',
    },
  });
  return manga;
};

const seedUser = (email: string) =>
  prisma.user.create({ data: { email, password_hash: 'not-a-real-hash' } });

describe('manga_override on a real database', () => {
  it('wins over the catalog on read, and a details refresh does not undo it', async () => {
    const manga = await seedManga();

    const res = await request(app)
      .patch(`/api/manga/${manga.id}/override`)
      .send({ title: 'My Title', description: 'My notes', status: 'COMPLETED' });
    expect(res.status).toBe(200);

    await mangaRepository.refreshDetails(manga.id, {
      author: 'Refreshed Author',
      artist: 'Artist',
      description: 'Refreshed description',
      genres: 'Action',
      status: 'HIATUS',
    });

    const details = await mangaService.getMangaDetailsById(manga.id);
    expect(details).toMatchObject({
      title: 'My Title',
      author: 'Refreshed Author',
      description: 'My notes',
      status: 'COMPLETED',
      override: {
        original: {
          title: 'Source Title',
          author: 'Refreshed Author',
          description: 'Refreshed description',
          status: 'HIATUS',
        },
      },
    });
    // The shared catalog keeps the source's values.
    expect(await prisma.manga.findUnique({ where: { id: manga.id } })).toMatchObject({
      title: 'Source Title',
    });
    const [listed] = await mangaService.getManga({});
    expect(listed).toMatchObject({ title: 'My Title', manga_detail: { status: 'COMPLETED' } });
  });

  it('keeps one anonymous row however many edits race, and reset removes it', async () => {
    const manga = await seedManga();

    await Promise.allSettled(
      ['A', 'B', 'C', 'D'].map((title) =>
        mangaOverrideRepository.upsert(manga.id, null, { title }),
      ),
    );
    await mangaOverrideRepository.upsert(manga.id, null, { author: 'Me' });
    expect(await prisma.manga_override.count({ where: { manga_id: manga.id } })).toBe(1);

    const reset = await request(app).delete(`/api/manga/${manga.id}/override`);
    expect(reset.status).toBe(200);
    expect(await prisma.manga_override.count()).toBe(0);
    expect((await mangaService.getMangaDetailsById(manga.id)).title).toBe('Source Title');
  });

  it('keeps accounts and anonymous use apart', async () => {
    const manga = await seedManga();
    const [alice, bob] = [await seedUser('alice@test.local'), await seedUser('bob@test.local')];

    await mangaOverrideRepository.upsert(manga.id, alice.id, { title: 'Alice Title' });
    await mangaOverrideRepository.upsert(manga.id, null, { title: 'Anonymous Title' });

    expect((await mangaService.getMangaDetailsById(manga.id, alice.id)).title).toBe('Alice Title');
    expect((await mangaService.getMangaDetailsById(manga.id, bob.id)).title).toBe('Source Title');
    expect((await mangaService.getMangaDetailsById(manga.id)).title).toBe('Anonymous Title');

    // Deleting the account takes its edits with it.
    await prisma.user.delete({ where: { id: alice.id } });
    expect(await prisma.manga_override.count()).toBe(1);
  });

  it('round-trips through a backup without leaking edits into the catalog', async () => {
    const manga = await seedManga();
    await mangaOverrideRepository.upsert(manga.id, null, {
      title: 'My Title',
      status: 'COMPLETED',
    });
    // What an export carries for this title: the merged details read.
    const exported = JSON.parse(JSON.stringify(await mangaService.getMangaDetailsById(manga.id)));
    const backup = replaceBackupBodySchema.parse({
      jobId: '2a5ef3a5-5d0f-4a51-9a5c-6b6a0a0b8f11',
      expectedUserId: null,
      version: 2,
      manga: [exported],
      library: [],
      history: [],
    });

    // Restore onto an install that has the title but not the edit.
    await prisma.manga_override.deleteMany();
    await replaceBackup(backup);

    const catalog = await prisma.manga.findUnique({
      where: { id: manga.id },
      include: { manga_detail: true },
    });
    expect(catalog).toMatchObject({
      title: 'Source Title',
      manga_detail: { status: 'ONGOING' },
    });
    expect(await mangaService.getMangaDetailsById(manga.id)).toMatchObject({
      title: 'My Title',
      status: 'COMPLETED',
    });
  });

  it('goes with the title when the title is deleted', async () => {
    const manga = await seedManga();
    await mangaOverrideRepository.upsert(manga.id, null, { title: 'Mine' });

    await mangaRepository.deleteManga(manga.id);

    expect(await prisma.manga_override.count()).toBe(0);
  });
});
