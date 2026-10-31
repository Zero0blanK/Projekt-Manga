'use client';

import Link from 'next/link';
import { Target } from 'lucide-react';
import type { HistoryEntry } from '@projekt-manga/api-client';
import { useNumberSetting, useSetting } from '@/lib/app-store';
import {
  GOAL_PERIODS,
  READING_GOAL_COUNT,
  READING_GOAL_PERIOD,
  goalProgress,
  type GoalPeriod,
} from '@/lib/reading-stats';

/** The reading goal set in Settings › Statistics, or null when there is none. */
export function useReadingGoal(): { count: number; period: GoalPeriod } | null {
  const count = useNumberSetting(READING_GOAL_COUNT, 0);
  const stored = useSetting(READING_GOAL_PERIOD, 'Week') as string;
  const period = (GOAL_PERIODS as readonly string[]).includes(stored)
    ? (stored as GoalPeriod)
    : 'Week';
  return count > 0 ? { count, period } : null;
}

/**
 * Progress toward the reading goal, from reading history. Compact on the library page,
 * fuller in Settings; renders nothing without a goal.
 */
export function ReadingGoalProgress({
  history,
  compact = false,
}: {
  history: readonly HistoryEntry[];
  compact?: boolean;
}) {
  const goal = useReadingGoal();
  if (!goal) return null;
  const progress = goalProgress(history, goal);
  const label = `${progress.read} of ${goal.count} chapters this ${goal.period.toLowerCase()}`;
  return (
    <Link
      href="/settings#statistics"
      aria-label={`Reading goal: ${label}${progress.met ? ', reached' : ''}`}
      title={label}
      className={`flex items-center gap-2 rounded-full border border-border/60 text-xs text-muted-foreground transition hover:text-foreground ${
        compact ? 'h-9 px-3' : 'px-3 py-2'
      }`}
    >
      <Target className={`h-4 w-4 ${progress.met ? 'text-primary' : ''}`} aria-hidden />
      <span className="tabular-nums">
        {progress.read}/{goal.count}
      </span>
      <span aria-hidden className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${Math.round(progress.fraction * 100)}%` }}
        />
      </span>
      {!compact && <span>{progress.met ? 'Goal reached' : label}</span>}
    </Link>
  );
}
