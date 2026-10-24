import { performance } from 'node:perf_hooks';
import prisma from '../../src/configs/prisma.config.js';
import { replaceBackupBodySchema, RESTORE_UPLOAD_LIMIT_BYTES } from '@projekt-manga/schemas';
import { replaceBackup } from '../../src/repositories/restore.repository.js';

const titleCount = 3_200;
const chaptersPerTitle = 5;
const payloadJobId = 'f3cb70fb-c494-4842-b9c6-e87a765b1ef2';

function buildPayload() {
  const titles = Array.from({ length: titleCount }, (_, titleIndex) => {
    const id = `benchmark-title-${titleIndex}`;
    return {
      id,
      source: 'restore-benchmark',
      slug: `title-${titleIndex}`,
      title: `Benchmark title ${titleIndex}`,
      author: 'Fixture author',
      thumbnail_url: 'https://example.test/cover.jpg',
      artist: null,
      description: 'Fixture description. '.repeat(12),
      genres: '',
      status: 'ONGOING',
      rating: null,
      chapters: Array.from({ length: chaptersPerTitle }, (_, chapterIndex) => ({
        id: `benchmark-chapter-${titleIndex}-${chapterIndex}`,
        url: `https://example.test/${titleIndex}/${chapterIndex}`,
        name: `Chapter ${chapterIndex + 1}`,
        scanlator: null,
        chapter_number: chapterIndex + 1,
        last_page_read: 0,
        is_read: false,
        is_bookmark: false,
        release_date: null,
        page_count: 20,
      })),
    };
  });
  const history = titles.flatMap((title) =>
    title.chapters.map((chapter) => ({
      source: 'restore-benchmark',
      manga_id: title.id,
      manga_slug: title.slug,
      chapter_id: chapter.id,
      pages_read: 0,
      time_read: 60_000,
      last_page_read: 0,
      is_read: false,
      read_at: '2026-09-01T00:00:00.000Z',
      last_read: '2026-09-01T00:00:00.000Z',
    })),
  );
  const backup = replaceBackupBodySchema.parse({
    jobId: payloadJobId,
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
    history,
  });
  const initialBytes = Buffer.byteLength(JSON.stringify(backup));
  if (initialBytes >= RESTORE_UPLOAD_LIMIT_BYTES) {
    throw new Error(`Base restore fixture is already ${initialBytes} bytes`);
  }
  // ASCII padding adds exactly one serialized byte per character. It keeps the complete,
  // schema-validated restore at the same byte boundary as Express's JSON body parser.
  backup.manga.at(-1)!.description += 'x'.repeat(RESTORE_UPLOAD_LIMIT_BYTES - initialBytes);
  const exactBackup = replaceBackupBodySchema.parse(backup);
  const payloadBytes = Buffer.byteLength(JSON.stringify(exactBackup));
  if (payloadBytes !== RESTORE_UPLOAD_LIMIT_BYTES) {
    throw new Error(`Expected ${RESTORE_UPLOAD_LIMIT_BYTES} payload bytes, got ${payloadBytes}`);
  }
  return { backup: exactBackup, payloadBytes, historyCount: history.length };
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.startsWith('file:') || !/test|ci/i.test(databaseUrl.slice(5))) {
    throw new Error(
      'Benchmark requires an explicit disposable SQLite DATABASE_URL containing test or ci',
    );
  }
  // This process is launched specifically for the benchmark, so maxRSS starts from the
  // runtime baseline rather than including preceding Vitest tests and their allocations.
  const baselineRssKiB = process.resourceUsage().maxRSS;
  const { backup, payloadBytes, historyCount } = buildPayload();
  const restoreStartedAt = performance.now();
  let competingWriter: Promise<unknown> | undefined;
  let writerStartedAt = 0;
  const result = await replaceBackup(backup, undefined, undefined, (completed, total) => {
    if (completed === 0 && total > 0 && !competingWriter) {
      writerStartedAt = performance.now();
      competingWriter = prisma.manga.create({
        data: {
          source: 'restore-benchmark-writer',
          slug: 'competing-writer',
          title: 'Competing writer',
          author: 'Fixture author',
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

  if (result.restoredManga !== titleCount || result.restoredHistory !== historyCount) {
    throw new Error(`Unexpected restore result: ${JSON.stringify(result)}`);
  }
  if ((await prisma.chapter.count()) !== titleCount * chaptersPerTitle) {
    throw new Error('Restored chapter count did not match the benchmark fixture');
  }

  console.log(
    `[restore-benchmark] ${JSON.stringify({
      titles: titleCount,
      chapters: titleCount * chaptersPerTitle,
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
