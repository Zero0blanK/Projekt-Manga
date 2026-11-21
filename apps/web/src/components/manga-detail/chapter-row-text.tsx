import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { titleShowsNumber } from './chapter-row';

/** How far into a chapter the reader got, when partway through it. */
export interface ChapterRowProgress {
  page: number;
  /** 0 when the chapter's page count isn't known yet. */
  total: number;
}

/**
 * The text of a chapter row, shared by the library and source lists.
 *
 * Read state leads the row, where the eye already is: a dot for unread, a ring filled to
 * the page reached for a chapter partway through, and a check with the title dimmed once
 * read. On wide screens the date and group sit in their own aligned columns rather than
 * under the title, so a long list reads like a table.
 */
export function ChapterRowText({
  number,
  title,
  date,
  group,
  read,
  progress,
  children,
}: {
  number: number;
  title: string;
  date?: string | null;
  group?: string | null;
  read: boolean;
  progress?: ChapterRowProgress | null;
  /** Badges (New, Offline…) shown right after the title. */
  children?: ReactNode;
}) {
  const numberLabel = titleShowsNumber(title, number) ? null : `Ch. ${number}`;
  const meta = [numberLabel, date, group].filter((part): part is string => !!part);
  const progressText = progress
    ? progress.total >= progress.page && progress.total > 0
      ? `Page ${progress.page} of ${progress.total}`
      : `Page ${progress.page}`
    : null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <ReadMarker read={read} progress={progress} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`truncate text-sm group-hover:text-primary ${
              read ? 'text-muted-foreground' : 'font-medium text-foreground'
            }`}
          >
            {title}
          </span>
          {children}
        </div>
        {(meta.length > 0 || progressText) && (
          <div
            className={`truncate text-xs tabular-nums text-muted-foreground ${
              progressText ? '' : 'lg:hidden'
            } ${read ? 'opacity-70' : ''}`}
          >
            {progressText && <span className="font-medium text-primary">{progressText}</span>}
            {/* Wide screens show the date and group in columns, so only the number stays. */}
            <span className={progressText ? 'lg:hidden' : ''}>
              {progressText && meta.length > 0 ? ' · ' : ''}
              {meta.join(' · ')}
            </span>
            {progressText && numberLabel && (
              <span className="hidden lg:inline"> · {numberLabel}</span>
            )}
          </div>
        )}
      </div>
      <span
        className={`hidden w-48 shrink-0 truncate text-xs text-muted-foreground lg:block ${read ? 'opacity-70' : ''}`}
      >
        {group}
      </span>
      <span
        className={`hidden w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground lg:block ${read ? 'opacity-70' : ''}`}
      >
        {date}
      </span>
    </div>
  );
}

const RING = 2 * Math.PI * 6;

function ReadMarker({ read, progress }: { read: boolean; progress?: ChapterRowProgress | null }) {
  if (read) {
    return (
      <span aria-hidden="true" className="grid w-4 shrink-0 place-items-center">
        <Check className="h-4 w-4 text-muted-foreground/70" strokeWidth={2.5} />
      </span>
    );
  }
  if (progress) {
    // An unknown page count still shows a started ring, a quarter round.
    const share = progress.total > 0 ? Math.min(1, progress.page / progress.total) : 0.25;
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-4 w-4 shrink-0 -rotate-90 text-primary"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={2.5}
        />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${share * RING} ${RING}`}
        />
      </svg>
    );
  }
  return (
    <span aria-hidden="true" className="grid w-4 shrink-0 place-items-center">
      <span className="h-2 w-2 rounded-full bg-primary" />
    </span>
  );
}
