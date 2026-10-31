import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/configs/prisma.config.js';
import libraryService from '../../src/services/library.service.js';

const DAY = 24 * 60 * 60 * 1000;
/** Midnight UTC a few days back, so the newest chapter is recent and never "stalled". */
const recent = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;

async function seedTitle(
  slug: string,
  options: { inLibrary?: boolean; releaseDays: number[]; groups?: number },
) {
  const manga = await prisma.manga.create({
    data: {
      slug,
      title: slug,
      author: 'Fixture author',
      source: 'source-a',
      thumbnail_url: 'https://example.com/thumb.jpg',
      in_library: options.inLibrary ?? false,
    },
  });
  // releaseDays are days before `recent`, oldest first; chapter n is the nth of them.
  const rows = options.releaseDays.flatMap((daysAgo, index) =>
    Array.from({ length: options.groups ?? 1 }, (_, group) => ({
      source: 'source-a',
      manga_slug: slug,
      manga_id: manga.id,
      source_chapter_key: `${slug}-${index + 1}-g${group}`,
      url: `https://example.com/${slug}/${index + 1}/${group}`,
      chapter_number: index + 1,
      // A second group releases the same chapter two days later.
      release_date: new Date(recent - daysAgo * DAY + group * 2 * DAY),
    })),
  );
  await prisma.chapter.createMany({ data: rows });
  return manga;
}

/** `count` releases `every` days apart, ending at `recent`. */
const cadence = (count: number, every: number) =>
  Array.from({ length: count }, (_, i) => (count - 1 - i) * every);

async function seedUser(email: string) {
  return prisma.user.create({ data: { email, password_hash: 'not-a-real-hash' } });
}

describe('GET /api/library/release-estimates (real DB)', () => {
  it('estimates library titles only, from the stored release dates', async () => {
    const weekly = await seedTitle('weekly', { inLibrary: true, releaseDays: cadence(6, 7) });
    await seedTitle('not-in-library', { releaseDays: cadence(6, 7) });
    await seedTitle('too-new', { inLibrary: true, releaseDays: cadence(2, 7) });

    const res = await request(app).get('/api/library/release-estimates');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        manga_id: weekly.id,
        interval_days: 7,
        last_chapter_at: new Date(recent).toISOString(),
        next_expected_at: new Date(recent + 7 * DAY).toISOString(),
      },
    ]);
  });

  it('counts a chapter released by several groups once, at its first release', async () => {
    const title = await seedTitle('two-groups', {
      inLibrary: true,
      releaseDays: cadence(5, 7),
      groups: 2,
    });
    const estimates = await libraryService.getReleaseEstimates();
    expect(estimates).toEqual([expect.objectContaining({ manga_id: title.id, interval_days: 7 })]);
  });

  it('estimates a long series from its recent schedule, not its early years', async () => {
    // 140 monthly chapters, then 12 weekly ones: 152 rows, past the 100-row read limit.
    const days = [...cadence(140, 30).map((d) => d + 12 * 7), ...cadence(12, 7)];
    const title = await seedTitle('long-series', { inLibrary: true, releaseDays: days });
    const estimates = await libraryService.getReleaseEstimates();
    expect(estimates).toEqual([expect.objectContaining({ manga_id: title.id, interval_days: 7 })]);
  });

  it('leaves out a series that stopped releasing long ago', async () => {
    await seedTitle('stalled', {
      inLibrary: true,
      releaseDays: cadence(6, 7).map((d) => d + 60),
    });
    expect(await libraryService.getReleaseEstimates()).toEqual([]);
  });

  it("uses an account's own library, ignoring removed entries and the shared shelf", async () => {
    const reader = await seedUser('reader@example.test');
    const other = await seedUser('other@example.test');
    const own = await seedTitle('own', { releaseDays: cadence(6, 7) });
    const removed = await seedTitle('removed', { releaseDays: cadence(6, 7) });
    const othersOnly = await seedTitle('others-only', { releaseDays: cadence(6, 7) });
    await seedTitle('anonymous-shelf', { inLibrary: true, releaseDays: cadence(6, 7) });
    await prisma.user_library.createMany({
      data: [
        { user_id: reader.id, manga_id: own.id },
        { user_id: reader.id, manga_id: removed.id, deleted_at: new Date() },
        { user_id: other.id, manga_id: othersOnly.id },
      ],
    });

    const estimates = await libraryService.getReleaseEstimates(reader.id);

    expect(estimates.map((e) => e.manga_id)).toEqual([own.id]);
  });
});
