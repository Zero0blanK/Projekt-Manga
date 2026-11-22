import { getSetting } from '@/lib/app-store';

/**
 * Back to the top of the page: the back-to-top button and a second click on the current
 * page's nav item.
 *
 * While smooth scrolling is on, the page's scroll belongs to Lenis
 * (components/smooth-scroll.tsx), which would ease a plain window.scrollTo back to where it
 * was heading; so it is asked to go there itself. Like every other scroll in the app, it
 * glides only while Settings › Appearance › Smooth scrolling is on and Reduce motion off,
 * and never against the system's reduced-motion preference.
 */
type PageScroller = {
  /** Where Lenis believes the page is. */
  scroll: number;
  scrollTo: (target: number, options?: { immediate?: boolean; force?: boolean }) => void;
};

let pageScroller: PageScroller | null = null;

/** Set by the page's smooth scrolling while it runs, and cleared when it stops. */
export function setPageScroller(scroller: PageScroller | null): void {
  pageScroller = scroller;
}

function glides(): boolean {
  const systemReduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    !systemReduced &&
    getSetting('smoothScroll', true) === true &&
    getSetting('reduceMotion', false) !== true
  );
}

export function scrollToTop(): void {
  const smooth = glides();
  if (pageScroller) {
    // Lenis can lose track of the page when it was moved some other way mid-glide (the
    // scrollbar dragged, a jump by script) and would then think it is already at the top.
    if (Math.abs(pageScroller.scroll - window.scrollY) > 1)
      pageScroller.scrollTo(window.scrollY, { immediate: true, force: true });
    pageScroller.scrollTo(0, { immediate: !smooth, force: true });
    return;
  }
  window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
}
