import { CHANGE_LABELS, type Change, type ChangeType } from '@/lib/changelog';

const TYPE_STYLES: Record<ChangeType, string> = {
  added: 'border-primary/40 bg-primary/10 text-primary',
  changed: 'border-border/70 bg-muted/60 text-foreground',
  fixed: 'border-border/70 bg-muted/40 text-muted-foreground',
  removed: 'border-destructive/40 bg-destructive/10 text-destructive',
};

/** One release's changes as labelled rows; shared by Settings → Changelog and the update prompt. */
export function ChangelogChanges({ changes }: { changes: Change[] }) {
  return (
    <ul className="space-y-2">
      {changes.map((change) => (
        <li key={`${change.type}:${change.text}`} className="flex items-start gap-2.5">
          <span
            className={`mt-0.5 w-[4.75rem] shrink-0 rounded-md border px-1.5 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide ${TYPE_STYLES[change.type]}`}
          >
            {CHANGE_LABELS[change.type]}
          </span>
          <span className="text-sm text-muted-foreground">{change.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Renders `**bold**` spans from changelog text as plain React nodes, never as markup. */
export function ChangelogText({ text }: { text: string }) {
  return (
    <>
      {text.split('**').map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold text-foreground">
            {part}
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}
