import type { ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

/**
 * The standard page frame: one container width, one set of gutters, one header block.
 *
 * Routing top-level pages through here keeps the content column from shifting when
 * navigating between them.
 */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className={PAGE_FRAME}>{children}</div>;
}

/** The frame's classes, for a page that needs them on an element of its own. */
export const PAGE_FRAME = 'mx-auto w-full min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8';

/**
 * Every page's title block. The title is the page's name, the one the navigation uses, so
 * where you are is the first thing read; what the page is for goes in the line below.
 */
export function PageHeader({
  title,
  description,
  back,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** A "Back to …" link above the title, for pages reached from another page. */
  back?: ReactNode;
  /** Buttons or links pinned to the right of the title, wrapping below it when narrow. */
  actions?: ReactNode;
  /** Controls that belong to the header, under the title (a page's tabs, say). */
  children?: ReactNode;
}) {
  return (
    <header>
      {back && <div className="mb-4">{back}</div>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display text-3xl text-foreground sm:text-4xl lg:text-5xl">{title}</h1>
          {description && <div className="mt-2 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}

/** The "Back to …" link a page puts above its title, in one style everywhere. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> {children}
    </Link>
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
