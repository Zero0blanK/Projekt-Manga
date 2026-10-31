import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/configs/prisma.config.js';
import mangaLinkRepository from '../../src/repositories/mangaLink.repository.js';
import { buildExport } from '../../src/services/backup.service.js';
import { replaceBackup } from '../../src/repositories/restore.repository.js';
import { replaceBackupBodySchema } from '@projekt-manga/schemas';

async function seed(slug: string, source = 'source-a', in_library = true) {
  return prisma.manga.create({
    data: {
      slug,
      title: slug,
      author: 'Author',
      source,
      thumbnail_url: `https://example.com/${slug}.jpg`,
      in_library,
    },
  });
}

describe('linked sources (real SQLite)', () => {
  it('links, orders and unlinks, and refuses chains and second homes', async () => {
    const primary = await seed('primary');
    const b = await seed('copy-b', 'source-b', false);
    const c = await seed('copy-c', 'source-c', false);
    const other = await seed('other');

    const linkB = await request(app)
      .post(`/api/manga/${primary.id}/links`)
      .send({ linked_manga_id: b.id });
    expect(linkB.status).toBe(201);
    const linkC = await request(app)
      .post(`/api/manga/${primary.id}/links`)
      .send({ linked_manga_id: c.id });
    expect(linkC.body.data.links.map((l: { linked: { id: string } }) => l.linked.id)).toEqual([
      b.id,
      c.id,
    ]);

    // Asking with a linked title gives the same group.
    const fromLinked = await request(app).get(`/api/manga/${b.id}/links`);
    expect(fromLinked.body.data.primary_id).toBe(primary.id);

    for (const [target, linked, message] of [
      [primary.id, primary.id, /itself/],
      [b.id, other.id, /itself linked/],
      [other.id, primary.id, /linked sources of its own/],
      [other.id, b.id, /already linked/],
    ] as const) {
      const res = await request(app)
        .post(`/api/manga/${target}/links`)
        .send({ linked_manga_id: linked });
      expect(res.status, `${target} <- ${linked}`).toBe(400);
      expect(res.body.message).toMatch(message);
    }
    expect(
      (await request(app).post(`/api/manga/${primary.id}/links`).send({ linked_manga_id: 'nope' }))
        .status,
    ).toBe(404);

    const ids = linkC.body.data.links.map((l: { id: string }) => l.id);
    const reordered = await request(app)
      .put(`/api/manga/${primary.id}/links/order`)
      .send({ link_ids: [...ids].reverse() });
    expect(reordered.body.data.links.map((l: { linked: { id: string } }) => l.linked.id)).toEqual([
      c.id,
      b.id,
    ]);
    expect(
      (
        await request(app)
          .put(`/api/manga/${primary.id}/links/order`)
          .send({ link_ids: [ids[0]] })
      ).status,
    ).toBe(400);

    const unlinked = await request(app).delete(`/api/manga/${primary.id}/links/${ids[0]}`);
    expect(unlinked.body.data.links).toHaveLength(1);
    expect((await request(app).delete(`/api/manga/${primary.id}/links/${ids[0]}`)).status).toBe(
      404,
    );

    const all = await request(app).get('/api/manga/links/all');
    expect(all.body.data).toEqual([
      expect.objectContaining({
        primary_id: primary.id,
        linked: [expect.objectContaining({ id: c.id })],
      }),
    ]);
  });

  it('reading a chapter on a linked source counts on the main title too', async () => {
    const main = await seed(`main-${randomUUID()}`);
    const other = await seed(`other-${randomUUID()}`, 'source-b', false);
    await mangaLinkRepository.create(main.id, other.id, null);
    const chapter = (manga_id: string, source: string, slug: string, key: string, n: number) =>
      prisma.chapter.create({
        data: {
          manga_id,
          source,
          manga_slug: slug,
          source_chapter_key: key,
          url: `/${key}`,
          chapter_number: n,
        },
      });
    const mainThree = await chapter(main.id, 'source-a', main.slug, 'a-3', 3);
    const mainFour = await chapter(main.id, 'source-a', main.slug, 'a-4', 4);
    await chapter(other.id, 'source-b', other.slug, 'b-3', 3);
    const otherZero = await chapter(other.id, 'source-b', other.slug, 'b-extra', 0);
    const mainZero = await chapter(main.id, 'source-a', main.slug, 'a-extra', 0);

    await request(app)
      .post(`/api/chapter/${other.slug}/b-3/mark-read`)
      .send({ source: 'source-b' })
      .expect(200);
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: mainThree.id } })).is_read).toBe(
      true,
    );
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: mainFour.id } })).is_read).toBe(
      false,
    );

    // Unread travels too; an unnumbered extra never does.
    await request(app)
      .post(`/api/chapter/${other.slug}/b-3/mark-unread`)
      .send({ source: 'source-b' })
      .expect(200);
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: mainThree.id } })).is_read).toBe(
      false,
    );
    await request(app)
      .post(`/api/chapter/${other.slug}/${otherZero.source_chapter_key}/mark-read`)
      .send({ source: 'source-b' })
      .expect(200);
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: mainZero.id } })).is_read).toBe(
      false,
    );
  });

  it("keeps each account's links to itself", async () => {
    const user = await prisma.user.create({
      data: { email: 'links-owner@example.com', password_hash: 'x' },
    });
    const primary = await seed('mine');
    const copy = await seed('mine-elsewhere', 'source-b', false);
    await mangaLinkRepository.create(primary.id, copy.id, user.id);

    expect((await mangaLinkRepository.groupFor(primary.id, user.id)).links).toHaveLength(1);
    expect((await mangaLinkRepository.groupFor(primary.id, null)).links).toHaveLength(0);
    // The anonymous library can link the same pair separately.
    await mangaLinkRepository.create(primary.id, copy.id, null);
    expect(await mangaLinkRepository.listAll(null)).toHaveLength(1);
  });

  it('carries links through a backup, standing a missing linked title back up', async () => {
    const primary = await seed('backed-up');
    const copy = await seed('backed-up-elsewhere', 'source-b', false);
    await mangaLinkRepository.create(primary.id, copy.id, null);

    const exported = await buildExport();
    const entry = (exported.manga as Array<{ slug: string; links?: unknown[] }>).find(
      (item) => item.slug === 'backed-up',
    );
    expect(entry?.links).toEqual([
      expect.objectContaining({ source: 'source-b', slug: 'backed-up-elsewhere', priority: 0 }),
    ]);

    // A server that never had the linked copy.
    await prisma.manga.delete({ where: { id: copy.id } });
    const backup = replaceBackupBodySchema.parse({
      ...(exported as object),
      jobId: randomUUID(),
      expectedUserId: null,
    });
    await replaceBackup(backup);

    const restoredPrimary = await prisma.manga.findUniqueOrThrow({
      where: { source_slug: { source: 'source-a', slug: 'backed-up' } },
    });
    const group = await mangaLinkRepository.groupFor(restoredPrimary.id, null);
    expect(group.links.map((link) => link.linked.slug)).toEqual(['backed-up-elsewhere']);
    const restoredCopy = await prisma.manga.findUniqueOrThrow({
      where: { source_slug: { source: 'source-b', slug: 'backed-up-elsewhere' } },
    });
    expect(restoredCopy.in_library).toBe(false);
  });
});
