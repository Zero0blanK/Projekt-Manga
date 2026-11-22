'use client';

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { scrollToTop } from '@/lib/scroll-to-top';

/**
 * A round button in the bottom-right corner, with the update and download dials, that goes
 * back to the top of the page. It shows only once the page has been scrolled down about a
 * screen, so it never sits there on a page that is already at the top.
 */
export function BackToTop() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const update = () => setShown(window.scrollY > window.innerHeight * 0.8);
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  if (!shown) return null;
  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Back to top"
      title="Back to top"
      className="pointer-events-auto grid size-12 place-items-center rounded-full border border-border/60 bg-popover/95 text-foreground shadow-xl shadow-black/30 backdrop-blur transition hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
    >
      <ArrowUp className="size-5" aria-hidden="true" />
    </button>
  );
}
