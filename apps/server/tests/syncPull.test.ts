import { describe, it, expect, beforeEach } from 'vitest';
import { prismaMock } from './mocks/prismaMock.js';
import syncService from '../src/services/sync.service.js';

/**
 * Paged pull is the one change in this codebase that could lose a reader's data silently.
 *
 * Each domain keeps a stable (timestamp, id) position while a pull is paged. The id
 * breaks timestamp ties that otherwise repeat the first page forever.
 */

const PAGE = 500;

function cursorPositions(cursor: string): Record<string, { at: string; id: string }> {
  expect(cursor).toMatch(/^v1\./);
  return JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8'));
}

function rows(count: number, startMs: number, field: 'updated_at' | 'last_read' = 'updated_at') {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${startMs}-${i}`,
    [field]: new Date(startMs + i * 1000),
  }));
}

function mockDomains(opts: {
  library?: unknown[];
  manga_state?: unknown[];
  chapter_state?: unknown[];
  manga_category?: unknown[];
  history?: unknown[];
}) {
  prismaMock.user_library.findMany.mockResolvedValueOnce(opts.library ?? []);
  prismaMock.user_manga_state.findMany.mockResolvedValueOnce(opts.manga_state ?? []);
  prismaMock.user_chapter_state.findMany.mockResolvedValueOnce(opts.chapter_state ?? []);
  prismaMock.user_manga_category.findMany.mockResolvedValueOnce(opts.manga_category ?? []);
  prismaMock.history.findMany.mockResolvedValueOnce(opts.history ?? []);
  prismaMock.category.findMany.mockResolvedValueOnce([]);
}

beforeEach(() => {
  prismaMock.category.findMany.mockResolvedValue([]);
  prismaMock.user.findUniqueOrThrow.mockResolvedValue({ sync_generation: 0 });
});

describe('sync pull paging', () => {
  it('reports no more work and advances to server_time when nothing is capped', async () => {
    mockDomains({ library: rows(3, 1_000) });

    const result = await syncService.pull('user-1');

    expect(result.has_more).toBe(false);
    expect(result.next_since).toBe(result.server_time);
    expect(result.library).toHaveLength(3);
  });

  it('caps a domain at the page size and asks the client to come back', async () => {
    mockDomains({ chapter_state: rows(PAGE + 1, 1_000) });

    const result = await syncService.pull('user-1');

    expect(result.has_more).toBe(true);
    expect(result.chapter_state).toHaveLength(PAGE);
    // The probe row is what revealed there is more; it must not be sent as data.
    expect(result.next_since).toMatch(/^v1\./);
  });

  it('resumes after the last row it sent', async () => {
    const start = Date.UTC(2026, 0, 1);
    mockDomains({ chapter_state: rows(PAGE + 1, start) });

    const result = await syncService.pull('user-1');

    // Last included row is index PAGE-1.
    const lastSent = new Date(start + (PAGE - 1) * 1000).getTime();
    expect(cursorPositions(result.next_since).chapter_state).toEqual({
      at: new Date(lastSent).toISOString(),
      id: `row-${start}-${PAGE - 1}`,
    });
  });

  it('advances through 501 rows that share a timestamp', async () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const tied = Array.from({ length: PAGE + 1 }, (_, i) => ({
      id: `row-${String(i).padStart(3, '0')}`,
      updated_at: at,
    }));
    mockDomains({ chapter_state: tied });

    const first = await syncService.pull('user-1');
    expect(cursorPositions(first.next_since).chapter_state).toEqual({
      at: at.toISOString(),
      id: 'row-499',
    });

    mockDomains({ chapter_state: [tied[PAGE]] });
    const second = await syncService.pull('user-1', first.next_since);
    expect(second.chapter_state).toEqual([tied[PAGE]]);
    expect(second.has_more).toBe(false);
    expect(prismaMock.user_chapter_state.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          user_id: 'user-1',
          OR: [{ updated_at: { gt: at } }, { updated_at: at, id: { gt: 'row-499' } }],
        },
      }),
    );
  });

  it('keeps independent positions for two capped domains', async () => {
    const early = Date.UTC(2026, 0, 1);
    const late = Date.UTC(2026, 6, 1);
    // Two domains both capped; library's pending work starts far earlier.
    mockDomains({
      library: rows(PAGE + 1, early),
      chapter_state: rows(PAGE + 1, late),
    });

    const result = await syncService.pull('user-1');

    // The library must retain its own earlier position while chapter state advances.
    const libraryLast = new Date(early + (PAGE - 1) * 1000).getTime();
    expect(cursorPositions(result.next_since).library).toEqual({
      at: new Date(libraryLast).toISOString(),
      id: `row-${early}-${PAGE - 1}`,
    });
    expect(cursorPositions(result.next_since).chapter_state.at).toBe(
      new Date(late + (PAGE - 1) * 1000).toISOString(),
    );
  });

  it('ignores an uncapped domain when choosing where to resume', async () => {
    const early = Date.UTC(2026, 0, 1);
    const late = Date.UTC(2026, 6, 1);
    // library is complete (its rows are older); only chapter_state has more to send.
    mockDomains({
      library: rows(2, early),
      chapter_state: rows(PAGE + 1, late),
    });

    const result = await syncService.pull('user-1');

    const chapterLast = new Date(late + (PAGE - 1) * 1000).getTime();
    expect(cursorPositions(result.next_since).chapter_state.at).toBe(
      new Date(chapterLast).toISOString(),
    );
    expect(cursorPositions(result.next_since).library).toEqual({ at: result.server_time, id: '' });
  });

  it('uses the server mutation timestamp for history', async () => {
    const start = Date.UTC(2026, 0, 1);
    mockDomains({ history: rows(PAGE + 1, start, 'sync_updated_at') });

    const result = await syncService.pull('user-1');

    expect(result.has_more).toBe(true);
    expect(cursorPositions(result.next_since).history).toEqual({
      at: new Date(start + (PAGE - 1) * 1000).toISOString(),
      id: `row-${start}-${PAGE - 1}`,
    });
  });

  it('asks each domain for one more row than a page, so "is there more" costs no extra query', async () => {
    mockDomains({});

    await syncService.pull('user-1');

    expect(prismaMock.user_library.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: PAGE + 1, orderBy: [{ updated_at: 'asc' }, { id: 'asc' }] }),
    );
    expect(prismaMock.history.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: PAGE + 1,
        orderBy: [{ sync_updated_at: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('orders every delta query, without which a page could not be resumed at all', async () => {
    mockDomains({});

    await syncService.pull('user-1');

    for (const model of [
      prismaMock.user_library,
      prismaMock.user_manga_state,
      prismaMock.user_chapter_state,
      prismaMock.user_manga_category,
    ]) {
      expect(model.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ updated_at: 'asc' }, { id: 'asc' }] }),
      );
    }
  });
});
