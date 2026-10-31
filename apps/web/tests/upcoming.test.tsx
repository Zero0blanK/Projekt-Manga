import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReleaseEstimate } from '@projekt-manga/api-client';
import type { Manga } from '@/lib/manga-data';
import { groupUpcoming } from '@/lib/upcoming';

const { estimates, library } = vi.hoisted(() => ({
  estimates: [] as ReleaseEstimate[],
  library: [] as Array<{ id: string; title: string; source: string; thumbnailUrl: null }>,
}));

vi.mock('@projekt-manga/api-client', () => ({
  getReleaseEstimates: vi.fn(async () => estimates),
}));
vi.mock('@/lib/library-store', () => ({
  useMangaLibrary: () => ({ manga: library, loading: false }),
}));
vi.mock('@/components/cover', () => ({ Cover: () => null }));
vi.mock('@/components/ui/calendar', () => ({ Calendar: () => <div data-testid="calendar" /> }));

import { UpcomingPageClient } from '@/app/upcoming/client';

const now = new Date(2026, 9, 28, 12);
const at = (days: number) => new Date(2026, 9, 28 + days, 9).toISOString();
const estimate = (manga_id: string, days: number, interval_days = 7): ReleaseEstimate => ({
  manga_id,
  interval_days,
  next_expected_at: at(days),
  last_chapter_at: at(days - interval_days),
});
const manga = (id: string) => ({ id, title: `Title ${id}`, source: 's', thumbnailUrl: null });

describe('groupUpcoming', () => {
  it('groups by local day, soonest first, with past-due titles together and unknown ids dropped', () => {
    const days = groupUpcoming(
      ['a', 'b', 'c', 'd'].map(manga) as unknown as Manga[],
      [estimate('a', 3), estimate('b', -2), estimate('c', -5), estimate('d', 3), estimate('x', 1)],
      now,
    );
    expect(days.map((day) => day.key)).toEqual(['overdue', '2026-10-31']);
    expect(days[0].entries.map((e) => e.manga.id)).toEqual(['c', 'b']);
    expect(days[1].entries.map((e) => e.manga.id)).toEqual(['a', 'd']);
  });
});

describe('Upcoming page', () => {
  it('lists expected titles under their day with their cadence', async () => {
    library.splice(0, library.length, manga('a'));
    estimates.splice(0, estimates.length, estimate('a', 400));
    render(<UpcomingPageClient />);
    expect(await screen.findByText('Title a')).toBeTruthy();
    expect(screen.getByText(/Weekly · last chapter/)).toBeTruthy();
  });

  it('explains when there is nothing to estimate', async () => {
    library.splice(0, library.length, manga('a'));
    estimates.splice(0, estimates.length);
    render(<UpcomingPageClient />);
    expect(await screen.findByText(/at least three dated chapters/)).toBeTruthy();
  });
});
