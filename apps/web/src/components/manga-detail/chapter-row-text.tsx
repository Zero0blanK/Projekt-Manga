import { titleShowsNumber } from './chapter-row';

/**
 * The two text lines of a chapter row, shared by the library and source lists: the title,
 * then date and group. The chapter number leads the second line only when the title
 * doesn't already say it.
 */
export function ChapterRowText({
  number,
  title,
  meta,
}: {
  number: number;
  title: string;
  /** Date, group… — empty entries are skipped. */
  meta: Array<string | null | undefined>;
}) {
  const parts = [titleShowsNumber(title, number) ? null : `Ch. ${number}`, ...meta].filter(
    (part): part is string => !!part,
  );
  return (
    <div className="min-w-0 flex-1 leading-tight">
      <div className="truncate text-sm font-medium text-foreground group-hover:text-primary">
        {title}
      </div>
      {parts.length > 0 && (
        <div className="truncate text-xs tabular-nums text-muted-foreground">
          {parts.join(' · ')}
        </div>
      )}
    </div>
  );
}
