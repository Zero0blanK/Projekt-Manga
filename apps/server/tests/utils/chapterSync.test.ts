import { describe, it, expect } from 'vitest';
import type { Chapters } from '@projekt-manga/types';
import { planChapterSync, type StoredChapter } from '../../src/utils/chapterSync.js';

const stored = (id: string, chapter_number: number, extra: Partial<StoredChapter> = {}) =>
  ({
    // Row ids differ from source keys, as they do for every chapter stored after the
    // switch to app-owned ids; the plan must report row ids.
    id: `row-${id}`,
    source_chapter_key: id,
    url: `/${id}`,
    name: `Chapter ${chapter_number}`,
    scanlator: null,
    chapter_number,
    release_date: null,
    ...extra,
  }) satisfies StoredChapter;

const listed = (id: string, chapter_number: number, extra: Partial<Chapters> = {}) =>
  ({
    id,
    url: `/${id}`,
    name: `Chapter ${chapter_number}`,
    chapter_number,
    last_page_read: 0,
    release_date: '',
    pages: [],
    ...extra,
  }) as Chapters;

describe('planChapterSync', () => {
  it('relinks a chapter the source now lists under a new id instead of adding it', () => {
    const plan = planChapterSync(
      [stored('a-1', 1), stored('a-2', 2)],
      [listed('a-1', 1), listed('b-2', 2), listed('a-3', 3)],
    );

    expect(plan.relinked).toEqual([
      { fromId: 'row-a-2', chapter: expect.objectContaining({ id: 'b-2' }) },
    ]);
    expect(plan.added.map((c) => c.id)).toEqual(['a-3']);
    expect(plan.stale).toEqual([]);
    expect(plan.suspicious).toBe(false);
  });

  it('relinks a whole-site URL change, which is not treated as a broken listing', () => {
    const plan = planChapterSync(
      [stored('old-1', 1), stored('old-2', 2), stored('old-3', 3)],
      [listed('new-1', 1), listed('new-2', 2), listed('new-3', 3)],
    );

    expect(plan.relinked.map((r) => [r.fromId, r.chapter.id])).toEqual([
      ['row-old-1', 'new-1'],
      ['row-old-2', 'new-2'],
      ['row-old-3', 'new-3'],
    ]);
    expect(plan.added).toEqual([]);
    expect(plan.suspicious).toBe(false);
  });

  it('matches on scanlator, treating missing, empty and Unknown as the same group', () => {
    const plan = planChapterSync(
      [stored('x', 4, { scanlator: 'Group A' }), stored('y', 4, { scanlator: 'Unknown' })],
      [listed('x2', 4, { scanlator: '' }), listed('y2', 4, { scanlator: 'group a' })],
    );

    expect(plan.relinked.map((r) => [r.fromId, r.chapter.id])).toEqual([
      ['row-y', 'x2'],
      ['row-x', 'y2'],
    ]);
  });

  it('pairs duplicate numbers one-to-one and adds the surplus', () => {
    const plan = planChapterSync(
      [stored('old', 10), stored('keep', 1)],
      [listed('keep', 1), listed('new-a', 10), listed('new-b', 10)],
    );

    expect(plan.relinked.map((r) => r.chapter.id)).toEqual(['new-a']);
    expect(plan.added.map((c) => c.id)).toEqual(['new-b']);
  });

  it('never pairs two chapters numbered 0: extras and unnumbered chapters all report 0', () => {
    const plan = planChapterSync(
      [stored('a-1', 1), stored('a-2', 2), stored('extra-old', 0)],
      [listed('a-1', 1), listed('a-2', 2), listed('oneshot-new', 0)],
    );
    expect(plan.relinked).toEqual([]);
    expect(plan.added.map((chapter) => chapter.id)).toEqual(['oneshot-new']);
    expect(plan.stale).toEqual(['row-extra-old']);
  });

  it('marks chapters with no counterpart as stale', () => {
    const plan = planChapterSync(
      [stored('c1', 1), stored('c2', 2), stored('c3', 3)],
      [listed('c1', 1), listed('c2', 2)],
    );

    expect(plan.stale).toEqual(['row-c3']);
    expect(plan.relinked).toEqual([]);
  });

  it('touches nothing when the source returns an empty list', () => {
    const plan = planChapterSync([stored('c1', 1)], []);

    expect(plan).toEqual({ added: [], relinked: [], updated: [], stale: [], suspicious: false });
  });

  it('only adds when most chapters vanished without number matches', () => {
    const plan = planChapterSync(
      [stored('c1', 1), stored('c2', 2), stored('c3', 3), stored('c4', 4)],
      [listed('c4', 4), listed('z1', 1)],
    );

    expect(plan.suspicious).toBe(true);
    expect(plan.relinked).toEqual([]);
    expect(plan.stale).toEqual([]);
    expect(plan.added.map((c) => c.id)).toEqual(['z1']);
  });

  it('reports changed metadata for known keys without blanking stored values', () => {
    const plan = planChapterSync(
      [stored('c1', 1, { url: '/old-path', name: 'Old', release_date: new Date('2026-01-01') })],
      [listed('c1', 0, { url: '/new-path', name: '', release_date: '2026-02-01T00:00:00.000Z' })],
    );

    expect(plan.updated).toEqual([
      {
        id: 'row-c1',
        data: { url: '/new-path', release_date: new Date('2026-02-01T00:00:00.000Z') },
      },
    ]);
  });

  it('matches by source key, so a row id that equals a listed key means nothing', () => {
    const plan = planChapterSync(
      [{ ...stored('k1', 1), id: 'k2' }],
      [listed('k1', 1), listed('k2', 2)],
    );

    expect(plan.added.map((c) => c.id)).toEqual(['k2']);
    expect(plan.relinked).toEqual([]);
    expect(plan.stale).toEqual([]);
  });

  it('ignores duplicate ids within one listing', () => {
    const plan = planChapterSync([], [listed('c1', 1), listed('c1', 1)]);

    expect(plan.added.map((c) => c.id)).toEqual(['c1']);
  });
});
