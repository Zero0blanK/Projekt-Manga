import type { ReactNode } from 'react';
import { Check, Users } from 'lucide-react';
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
 * read. On wide screens the scanlation group and date sit in their own aligned columns rather than
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
  const groupName = group?.trim() || 'Unknown group';
  const progressText = progress
    ? progress.total >= progress.page && progress.total > 0
      ? `Page ${progress.page} of ${progress.total}`
      : `Page ${progress.page}`
    : null;
  // Always shown: where the reader got to, and the number when the title doesn't say it.
  const lead = [progressText, numberLabel].filter((part): part is string => !!part);
  // Under the title on narrow screens only; wide screens give these their own columns.
  const narrow = [date, groupName].filter((part): part is string => !!part);

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
        <div
          className={`truncate text-xs tabular-nums text-muted-foreground ${
            lead.length ? '' : 'lg:hidden'
          } ${read ? 'opacity-70' : ''}`}
        >
          {progressText && <span className="font-medium text-primary">{progressText}</span>}
          {numberLabel && (progressText ? ` · ${numberLabel}` : numberLabel)}
          <span className="lg:hidden">
            {lead.length ? ' · ' : ''}
            {narrow.join(' · ')}
          </span>
        </div>
      </div>
      <span
        title={group ? `Scanlation group: ${group}` : 'The source doesn’t name a group'}
        className={`hidden w-52 shrink-0 items-center gap-1.5 text-xs lg:flex ${
          group ? 'text-foreground/75' : 'text-muted-foreground/60'
        } ${read ? 'opacity-70' : ''}`}
      >
        <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{groupName}</span>
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
