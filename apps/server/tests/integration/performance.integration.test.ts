import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import prisma from '../../src/configs/prisma.config.js';
import mangaRepository from '../../src/repositories/manga.repository.js';
import chapterRepository from '../../src/repositories/chapter.repository.js';
import historyRepository from '../../src/repositories/history.repository.js';
import syncService from '../../src/services/sync.service.js';

const chunkSize = 500;

async function createInChunks<T>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += chunkSize) {
    await insert(rows.slice(start, start + chunkSize));
  }
}

async function medianMilliseconds(run: () => Promise<unknown>): Promise<number> {
  await run(); // Warm SQLite and Prisma before recording the samples.
  const samples: number[] = [];
  for (let sample = 0; sample < 3; sample++) {
    const startedAt = performance.now();
    await run();
    samples.push(performance.now() - startedAt);
  }
  return samples.sort((a, b) => a - b)[1];
}

describe('large-library query baselines (real SQLite)', () => {
  it('measures account library, chapter list, history, and sync pull workloads', async () => {
    const titleCount = 1_000;
    const chaptersPerTitle = 20;
    // A single series reaches the planned 50,000-chapter ceiling; the other titles keep
    // the multi-title library workload representative as well.
    const largeTitleExtraChapters = 49_980;
    const historyCount = 10_000;
    const user = await prisma.user.create({
      data: { email: 'large-library-benchmark@example.test', password_hash: 'fixture-only' },
    });
    const titles = Array.from({ length: titleCount }, (_, index) => ({
      id: `perf-title-${index}`,
      source: 'performance-fixture',
      slug: `title-${index}`,
      title: `Performance title ${String(index).padStart(4, '0')}`,
      author: 'Fixture author',
      thumbnail_url: '',
      in_library: false,
    }));
    await createInChunks(titles, (batch) => prisma.manga.createMany({ data: batch }));

    const chapters = titles.flatMap((title, titleIndex) =>
      Array.from({ length: chaptersPerTitle }, (_, chapterIndex) => ({
        id: `perf-chapter-${titleIndex}-${chapterIndex}`,
        manga_id: title.id,
        url: 'https://example.test/chapter',
        name: `Chapter ${chapterIndex + 1}`,
        chapter_number: chapterIndex + 1,
      })),
    );
    chapters.push(
      ...Array.from({ length: largeTitleExtraChapters }, (_, index) => ({
        id: `perf-long-series-${index}`,
        manga_id: titles[0].id,
        url: 'https://example.test/long-series',
        name: `Chapter ${chaptersPerTitle + index + 1}`,
        chapter_number: chaptersPerTitle + index + 1,
      })),
    );
    await createInChunks(chapters, (batch) => prisma.chapter.createMany({ data: batch }));

    await createInChunks(
      titles.map((title) => ({ user_id: user.id, manga_id: title.id })),
      (batch) => prisma.user_library.createMany({ data: batch }),
    );
    await createInChunks(
      chapters.map((chapter, index) => ({
        user_id: user.id,
        chapter_id: chapter.id,
        is_read: index % 2 === 0,
        last_page_read: index % 2 === 0 ? 12 : 0,
      })),
      (batch) => prisma.user_chapter_state.createMany({ data: batch }),
    );

    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const history = Array.from({ length: historyCount }, (_, index) => {
      const chapter = chapters[index];
      const title = titles[Math.floor(index / chaptersPerTitle) % titles.length];
      return {
        id: `perf-history-${index}`,
        user_id: user.id,
        manga_id: chapter.manga_id,
        chapter_id: chapter.id,
        source: 'performance-fixture',
        manga_slug: title.slug,
        title: title.title,
        read_at: timestamp,
        last_read: new Date(timestamp.getTime() + index),
        sync_updated_at: new Date(timestamp.getTime() + index),
        pages_read: 12,
        time_read: 60_000,
      };
    });
    await createInChunks(history, (batch) => prisma.history.createMany({ data: batch }));

    const libraryRows = await mangaRepository.getMangaForUser(user.id, {});
    expect(libraryRows).toHaveLength(titleCount);
    expect(libraryRows[0].chapter_count).toBe(chaptersPerTitle + largeTitleExtraChapters);
    expect(libraryRows[0].unread_count).toBe(
      Math.ceil((chaptersPerTitle + largeTitleExtraChapters) / 2),
    );
    const chapterRows = await chapterRepository.getChapter(titles[0].id);
    expect(chapterRows).toHaveLength(chaptersPerTitle + largeTitleExtraChapters);
    const historyRows = await historyRepository.getHistory(user.id);
    expect(historyRows).toHaveLength(historyCount);
    const syncPage = await syncService.pull(user.id);
    expect(syncPage.history).toHaveLength(500);
    expect(syncPage.has_more).toBe(true);

    const timings = {
      library_ms: await medianMilliseconds(() => mangaRepository.getMangaForUser(user.id, {})),
      chapter_list_ms: await medianMilliseconds(() => chapterRepository.getChapter(titles[0].id)),
      history_ms: await medianMilliseconds(() => historyRepository.getHistory(user.id)),
      sync_pull_ms: await medianMilliseconds(() => syncService.pull(user.id)),
    };
    expect(timings.library_ms).toBeLessThan(2_000);
    expect(timings.chapter_list_ms).toBeLessThan(1_000);
    expect(timings.history_ms).toBeLessThan(3_000);
    expect(timings.sync_pull_ms).toBeLessThan(1_000);
    console.info(
      `[large-library-benchmark] titles=${titleCount} chapters=${chapters.length} history=${historyCount} ` +
        `library_ms=${Math.round(timings.library_ms)} chapter_list_ms=${Math.round(timings.chapter_list_ms)} ` +
        `history_ms=${Math.round(timings.history_ms)} sync_pull_ms=${Math.round(timings.sync_pull_ms)}`,
    );
  }, 300_000);
});
