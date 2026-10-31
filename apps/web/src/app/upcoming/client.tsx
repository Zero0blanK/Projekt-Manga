'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import { getReleaseEstimates, type ReleaseEstimate } from '@projekt-manga/api-client';
import { Calendar } from '@/components/ui/calendar';
import { Cover } from '@/components/cover';
import { EmptyState, PageHeader, PageShell, RowList } from '@/components/page-shell';
import { useMangaLibrary } from '@/lib/library-store';
import { isAborted } from '@/lib/report-error';
import { dayKey, groupUpcoming } from '@/lib/upcoming';

const dayLabel = (date: Date | null) =>
  date
    ? date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : 'Overdue';

const cadence = (days: number) =>
  days === 1 ? 'Daily' : days === 7 ? 'Weekly' : `About every ${Math.round(days)} days`;

export function UpcomingPageClient() {
  const { manga: library, loading: libraryLoading } = useMangaLibrary();
  const [estimates, setEstimates] = useState<ReleaseEstimate[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getReleaseEstimates(controller.signal)
      .then(setEstimates)
      .catch((error) => {
        // The page explains the failure itself; a toast would say it twice.
        if (!isAborted(error)) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  const days = useMemo(
    () => (estimates ? groupUpcoming(library, estimates) : []),
    [library, estimates],
  );
  const expectedDays = days.flatMap((day) => (day.date ? [day.date] : []));

  return (
    <PageShell>
      <PageHeader
        icon={CalendarDays}
        eyebrow="Upcoming"
        title="What's coming next"
        description="Expected release days, estimated from each title's recent chapters."
      />

      {failed ? (
        <div className="mt-8">
          <EmptyState icon={CalendarDays}>
            Release estimates couldn&apos;t be loaded. They need the server, so they aren&apos;t
            available offline.
          </EmptyState>
        </div>
      ) : estimates === null || libraryLoading ? (
        <p role="status" className="mt-8 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : days.length === 0 ? (
        <div className="mt-8">
          <EmptyState icon={CalendarDays}>
            Nothing to predict yet. A title needs at least three dated chapters before its next
            release can be estimated.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[auto_1fr]">
          <Calendar
            className="h-fit rounded-2xl border border-border/60 bg-surface/40"
            modifiers={{ expected: expectedDays }}
            modifiersClassNames={{ expected: 'font-semibold text-primary' }}
            onDayClick={(date) =>
              document
                .getElementById(`upcoming-${dayKey(date)}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          />
          <div className="space-y-6">
            {days.map((day) => (
              <section
                key={day.key}
                id={`upcoming-${day.key}`}
                aria-label={dayLabel(day.date)}
                className="scroll-mt-20"
              >
                <h2 className="mb-2 text-sm font-semibold">{dayLabel(day.date)}</h2>
                <RowList>
                  {day.entries.map(({ manga, estimate }) => (
                    <li key={manga.id}>
                      <Link
                        href={`/manga/${manga.id}`}
                        className="flex items-center gap-3 p-3 transition hover:bg-accent/40"
                      >
                        <Cover
                          sourceId={manga.source}
                          mangaId={manga.id}
                          src={manga.thumbnailUrl}
                          alt=""
                          className="h-14 w-10 shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{manga.title}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {cadence(estimate.interval_days)} · last chapter{' '}
                            {new Date(estimate.last_chapter_at).toLocaleDateString()}
                          </div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </RowList>
              </section>
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}
