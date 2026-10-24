'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { hasNavigatedInApp } from '@/lib/nav-history';

/**
 * Leaves the reader without growing the history stack. Pushing the detail URL instead
 * would leave the reader sitting behind the detail page, so the detail page's own "back"
 * would return to the chapter you just closed rather than to the list you came from.
 *
 * Falls back to a plain navigation when the reader was opened directly (deep link or new
 * tab), where there is nothing behind it to return to.
 */
export function ExitReaderButton({
  fallbackHref,
  label,
  className,
  children,
  escapeKey = false,
}: {
  fallbackHref: string;
  label: string;
  className?: string;
  children: ReactNode;
  /** Also leave on Escape. Only one exit control on a page may set this. */
  escapeKey?: boolean;
}) {
  const router = useRouter();
  // Resolved post-mount: sessionStorage is unavailable during SSR.
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => setCanGoBack(hasNavigatedInApp()), []);
  const exit = () => (canGoBack ? router.back() : router.push(fallbackHref));

  // Escape leaves the reader, as in most readers. Checked in the capture phase, before an
  // open menu or dialog handles the same key and closes itself: Escape then only closes it.
  useEffect(() => {
    if (!escapeKey) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      if (
        document.querySelector(
          '[role="dialog"], [role="menu"], [role="listbox"], [data-escape-closes]',
        )
      )
        return;
      exit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <button
      type="button"
      aria-label={label}
      className={className}
      aria-keyshortcuts={escapeKey ? 'Escape' : undefined}
      onClick={exit}
    >
      {children}
    </button>
  );
}
