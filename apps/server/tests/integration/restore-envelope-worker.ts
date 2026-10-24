import { performance } from 'node:perf_hooks';
import prisma from '../../src/configs/prisma.config.js';
import { replaceBackupBodySchema, RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';
import { replaceBackup } from '../../src/repositories/restore.repository.js';

type Scenario = 'titles' | 'chapters' | 'history';

const jobIds: Record<Scenario, string> = {
  titles: '2278fb90-8e48-42a1-a21b-6212cbe83c01',
  chapters: '1cc98cb9-361f-4954-8336-5708be532f80',
  history: 'af22be89-1a14-46b3-87f6-560e7c068212',
};

function buildPayload(scenario: Scenario) {
  const titleCount = scenario === 'titles' ? 10_000 : scenario === 'chapters' ? 1 : 0;
  const chapterCount = scenario === 'chapters' ? 50_000 : 0;
  const historyCount = scenario === 'history' ? 50_000 : 0;
  const titles = Array.from({ length: titleCount }, (_, index) => {
    const id = `${scenario}-title-${index}`;
    return {
      id,
      source: `restore-envelope-${scenario}`,
      slug: `title-${index}`,
      title: `Title ${index}`,
      author: 'A',
      thumbnail_url: 'x',
      artist: null,
      description: '',
      genres: '',
      status: 'ONGOING',
      rating: null,
      chapters:
        scenario === 'chapters'
          ? Array.from({ length: chapterCount }, (_, chapterIndex) => ({
              id: `envelope-chapter-${chapterIndex}`,
              url: 'x',
              name: 'c',
              scanlator: null,
              chapter_number: chapterIndex + 1,
              last_page_read: 0,
              is_read: false,
              is_bookmark: false,
              release_date: null,
              page_count: 1,
            }))
          : [],
    };
  });
  const backup = replaceBackupBodySchema.parse({
    jobId: jobIds[scenario],
    mode: 'replace',
    expectedUserId: null,
    version: 2,
    manga: titles,
    library: titles.map((title) => ({
      manga_id: title.id,
      is_bookmarked: false,
      shelf_status: null,
      notification_read: false,
    })),
    history:
      scenario === 'history'
        ? Array.from({ length: historyCount }, (_, index) => ({
            source: 'restore-envelope-history',
            manga_slug: `history-${index}`,
            pages_read: 1,
            read_at: '2026-09-01T00:00:00.000Z',
            last_read: '2026-09-01T00:00:00.000Z',
            last_page_read: 0,
          }))
        : [],
  });
  const payloadBytes = Buffer.byteLength(JSON.stringify(backup));
  if (payloadBytes > RESTORE_UPLOAD_LIMIT_BYTES) {
    throw new Error(
      `${scenario} fixture exceeds upload limit: ${payloadBytes} > ${RESTORE_UPLOAD_LIMIT_BYTES}`,
    );
  }
  return { backup, payloadBytes, titleCount, chapterCount, historyCount };
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.startsWith('file:') || !/test|ci/i.test(databaseUrl.slice(5))) {
    throw new Error(
      'Benchmark requires an explicit disposable SQLite DATABASE_URL containing test or ci',
    );
  }
  const scenario = process.argv[2] as Scenario | undefined;
  if (!scenario || !(scenario in jobIds)) {
    throw new Error('Pass one row-envelope scenario: titles, chapters, or history');
  }

  const baselineRssKiB = process.resourceUsage().maxRSS;
  const { backup, payloadBytes, titleCount, chapterCount, historyCount } = buildPayload(scenario);
  const restoreStartedAt = performance.now();
  let competingWriter: Promise<unknown> | undefined;
  let writerStartedAt = 0;
  const result = await replaceBackup(backup, undefined, undefined, (completed, total) => {
    if (completed === 0 && total > 0 && !competingWriter) {
      writerStartedAt = performance.now();
      competingWriter = prisma.manga.create({
        data: {
          source: `restore-envelope-${scenario}-writer`,
          slug: `writer-${scenario}`,
          title: 'Writer',
          author: 'A',
          thumbnail_url: '',
          in_library: false,
        },
      });
    }
  });
  const restoreMs = performance.now() - restoreStartedAt;
  if (!competingWriter) throw new Error('Restore did not expose its initial progress callback');
  await competingWriter;
  const writerWaitMs = performance.now() - writerStartedAt;
  const peakRssDeltaBytes = Math.max(0, process.resourceUsage().maxRSS - baselineRssKiB) * 1024;

  if (
    result.restoredManga !== titleCount ||
    result.restoredProgress !== 0 ||
    result.restoredHistory !== historyCount
  ) {
    throw new Error(`Unexpected restore result: ${JSON.stringify(result)}`);
  }
  if ((await prisma.chapter.count()) !== chapterCount) {
    throw new Error(`Restored chapter count did not match ${scenario} fixture`);
  }
  if (
    (await prisma.history.count({ where: { source: 'restore-envelope-history' } })) !== historyCount
  ) {
    throw new Error(`Restored history count did not match ${scenario} fixture`);
  }

  console.log(
    `[restore-envelope] ${JSON.stringify({
      scenario,
      titles: titleCount,
      chapters: chapterCount,
      library: titleCount,
      history: historyCount,
      payloadBytes,
      restoreMs: Math.round(restoreMs),
      writerWaitMs: Math.round(writerWaitMs),
      peakRssDeltaBytes,
    })}`,
  );
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
