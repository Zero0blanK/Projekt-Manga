'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { getPreviousLocation, type PreviousLocation } from '@/lib/nav-history';

/**
 * Returns to wherever the reader actually came from — the Popular grid, Latest, search
 * results, wherever — rather than a fixed destination. Uses router.back() so the browser
 * restores that page's scroll position and the list keeps whatever state it had, which a
 * fresh push to the same URL would not.
 *
 * Falls back to `fallbackHref` when there's no in-app history to return to (opened in a
 * new tab, or a shared link pasted directly).
 */
export function MangaDetailBackLink({
  fallbackHref,
  fallbackLabel,
}: {
  fallbackHref: string;
  fallbackLabel: string;
}) {
  const router = useRouter();
  // Resolved after mount: sessionStorage isn't available during SSR, and rendering the
  // fallback first avoids a hydration mismatch.
  const [previous, setPrevious] = useState<PreviousLocation | null>(null);
  useEffect(() => setPrevious(getPreviousLocation()), []);

  const className =
    'inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground';

  if (!previous) {
    return (
      <Link href={fallbackHref} className={className}>
        <ChevronLeft className="h-3.5 w-3.5" /> Back to {fallbackLabel}
      </Link>
    );
  }

  return (
    <button onClick={() => router.back()} className={className}>
      <ChevronLeft className="h-3.5 w-3.5" /> Back to {previous.label}
    </button>
  );
}
