import type { ComponentType, ReactNode } from 'react';

/**
 * The standard page frame: one container width, one set of gutters, one header block.
 *
 * Routing top-level pages through here keeps the content column from shifting when
 * navigating between them.
 */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto min-w-0 max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</div>;
}

export function PageHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  actions,
}: {
  icon: ComponentType<{ className?: string }>;
  eyebrow: string;
  title: string;
  description?: ReactNode;
  /** Buttons or links pinned to the right of the title, wrapping below it when narrow. */
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-primary">
          <Icon className="h-3 w-3" /> {eyebrow}
        </div>
        <h1 className="mt-1 text-display text-3xl text-foreground sm:text-4xl lg:text-5xl">
          {title}
        </h1>
        {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled block within a page. `PageBody` sets the rhythm between them, so sections
 * never carry their own top margin. */
export function PageSection({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-display text-2xl text-foreground">{title}</h2>
          {subtitle && (
            <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Everything below the header, with consistent spacing between sections. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="mt-10 space-y-10">{children}</div>;
}

/** The shared "nothing here yet" block. */
export function EmptyState({
  icon: Icon,
  children,
}: {
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 p-12 text-center">
      {Icon && <Icon className="mx-auto mb-2 h-7 w-7 text-muted-foreground" />}
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

/** The bordered list card used for row-based content on every one of these pages. */
export function RowList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
      {children}
    </ul>
  );
}
