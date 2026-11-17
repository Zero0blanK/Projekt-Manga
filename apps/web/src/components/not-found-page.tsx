import Link from 'next/link';
import type { ReactNode } from 'react';

/** A 404, for whatever the route was meant to show. Server-rendered: no hooks. */
export function NotFoundPage({
  title,
  children,
  links,
}: {
  title: string;
  children: ReactNode;
  /** The first is the main way on. */
  links: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-4 py-16 text-center">
      <p className="text-display text-6xl text-muted-foreground">404</p>
      <h1 className="mt-4 text-xl font-semibold text-foreground">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {links.map((link, index) => (
          <Link
            key={link.href}
            href={link.href}
            className={
              index === 0
                ? 'inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90'
                : 'inline-flex items-center justify-center rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent'
            }
          >
            {link.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** A library title that isn't there: removed, or a link from before it was. */
export function TitleNotFound() {
  return (
    <NotFoundPage
      title="This title isn't in your library"
      links={[
        { href: '/', label: 'Back to library' },
        { href: '/discover', label: 'Find it in Discover' },
      ]}
    >
      It may have been removed, or the link is from before it was. Add it again from Discover to
      keep reading.
    </NotFoundPage>
  );
}
