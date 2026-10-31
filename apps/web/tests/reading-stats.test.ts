import { describe, expect, it } from 'vitest';
import { goalProgress, historyYears, periodStart, yearInManga } from '@/lib/reading-stats';

const at = (iso: string, title = 'Frieren', minutes = 10) => ({
  last_read: new Date(iso).toISOString(),
  time_read: minutes * 60_000,
  title,
  manga_slug: title.toLowerCase(),
  manga_id: title,
});

describe('reading goals', () => {
  // Wednesday 15 July 2026, local time.
  const now = new Date(2026, 6, 15, 12);

  it('starts weeks on Monday and months on the 1st', () => {
    expect(periodStart('Week', now)).toEqual(new Date(2026, 6, 13));
    expect(periodStart('Month', now)).toEqual(new Date(2026, 6, 1));
  });

  it('counts chapters read in the period against the goal', () => {
    const history = [
      at('2026-07-14T10:00:00'),
      at('2026-07-15T09:00:00'),
      at('2026-07-12T10:00:00'), // last week
    ];
    expect(goalProgress(history, { count: 4, period: 'Week' }, now)).toEqual({
      read: 2,
      goal: 4,
      fraction: 0.5,
      met: false,
    });
    expect(goalProgress(history, { count: 3, period: 'Month' }, now).met).toBe(true);
  });
});

describe('year in manga', () => {
  const history = [
    at('2026-01-03T10:00:00', 'Frieren', 30),
    at('2026-01-04T10:00:00', 'Frieren', 30),
    at('2026-01-05T10:00:00', 'Dandadan'),
    at('2026-01-05T20:00:00', 'Frieren'),
    at('2026-03-01T10:00:00', 'Dandadan'),
    at('2025-12-31T10:00:00', 'Old title'),
  ];

  it('sums the year and ranks titles and genres', () => {
    const genres: Record<string, string[]> = {
      Frieren: ['Fantasy'],
      Dandadan: ['Action', 'Fantasy'],
    };
    const stats = yearInManga(history, 2026, (entry) => genres[entry.manga_id ?? ''] ?? []);
    expect(stats).toMatchObject({
      chapters: 5,
      titles: 2,
      hours: 1.5,
      longestStreak: 3,
      busiestDay: { date: '2026-01-05', chapters: 2 },
      topTitles: [
        { title: 'Frieren', chapters: 3 },
        { title: 'Dandadan', chapters: 2 },
      ],
      topGenres: [
        { genre: 'Fantasy', chapters: 5 },
        { genre: 'Action', chapters: 2 },
      ],
    });
    expect(stats.months.slice(0, 3)).toEqual([4, 0, 1]);
  });

  it('lists the years with reading and handles an empty one', () => {
    expect(historyYears(history)).toEqual([2026, 2025]);
    expect(yearInManga(history, 2020)).toMatchObject({
      chapters: 0,
      busiestDay: null,
      longestStreak: 0,
    });
  });
});
