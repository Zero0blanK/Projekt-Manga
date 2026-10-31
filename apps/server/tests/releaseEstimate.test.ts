import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prismaMock } from './mocks/prismaMock.js';
import { estimateRelease } from '../src/utils/releaseEstimate.js';

const DAY = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 0, 1);
const on = (day: number) => new Date(start + day * DAY);
const weekly = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ chapter_number: i + 1, date: on(i * 7) }));

describe('estimateRelease', () => {
  it('predicts the next chapter from a regular cadence', () => {
    const estimate = estimateRelease(weekly(6), on(36).getTime());
    expect(estimate).toEqual({
      interval_days: 7,
      last_chapter_at: on(35),
      next_expected_at: on(42),
    });
  });

  it('uses the median, so one long break does not skew an otherwise regular schedule', () => {
    const chapters = [0, 7, 14, 60, 67, 74].map((day, i) => ({
      chapter_number: i + 1,
      date: on(day),
    }));
    expect(estimateRelease(chapters, on(75).getTime())?.interval_days).toBe(7);
  });

  it('counts a chapter released by several groups, or a same-day batch, once', () => {
    const chapters = [
      ...weekly(4),
      { chapter_number: 2, date: on(9) }, // a second group, later
      { chapter_number: 5, date: on(21) }, // released the same day as chapter 4
    ];
    expect(estimateRelease(chapters, on(22).getTime())?.interval_days).toBe(7);
  });

  it('gives no estimate with fewer than three releases, undated chapters, or a dormant series', () => {
    expect(estimateRelease(weekly(2))).toBeNull();
    expect(estimateRelease([{ chapter_number: 1, date: null }, ...weekly(2)])).toBeNull();
    const yearly = [0, 365, 730].map((day, i) => ({ chapter_number: i + 1, date: on(day) }));
    expect(estimateRelease(yearly, on(731).getTime())).toBeNull();
  });

  it('drops the estimate of a series long past its expected release', () => {
    // Weekly: last chapter on day 35, next expected on day 42, stalled 3 weeks after that.
    expect(estimateRelease(weekly(6), on(63).getTime())).not.toBeNull();
    expect(estimateRelease(weekly(6), on(64).getTime())).toBeNull();
  });
});

describe('GET /api/library/release-estimates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('estimates each title in the shared library and omits ones without history', async () => {
    prismaMock.manga.findMany.mockResolvedValueOnce([
      {
        id: 'weekly',
        chapter: weekly(4).map((c, i) => ({
          chapter_number: c.chapter_number,
          // The second chapter has no source date; when it was first seen stands in.
          release_date: i === 1 ? null : c.date,
          created_at: c.date,
        })),
      },
      { id: 'new', chapter: [{ chapter_number: 1, release_date: on(0), created_at: on(0) }] },
    ] as never);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(on(22));

    const res = await request(app).get('/api/library/release-estimates');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        manga_id: 'weekly',
        interval_days: 7,
        last_chapter_at: on(21).toISOString(),
        next_expected_at: on(28).toISOString(),
      },
    ]);
    expect(prismaMock.manga.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { in_library: true } }),
    );
  });
});
