'use client';

import { useEffect } from 'react';
import Lenis from 'lenis';
import { SCROLL_LOCK_ATTRIBUTE, keepsNativeScroll } from '@/lib/smooth-scroll';

/** The same easing as the long-strip reader (components/reader/long-strip-viewer.tsx). */
const SMOOTH_SCROLL_LERP = 0.12;

/**
 * Smooth wheel scrolling for the page itself (the window), on every screen but the reader,
 * which smooths its own strip. Mounted by the app shell while Settings > Appearance >
 * Smooth scrolling is on and Reduce motion is off; the system's reduced-motion preference
 * is honoured by Lenis itself.
 *
 * Lenis wraps the browser's own scroll, so sticky headers, infinite-scroll observers and
 * scroll restoration see ordinary scrolling. Scroll areas inside the page (chapter lists,
 * carousels) still scroll themselves (`allowNestedScroll`), and touch stays native.
 */
export function SmoothScroll() {
  useEffect(() => {
    const lenis = new Lenis({
      autoRaf: true,
      lerp: SMOOTH_SCROLL_LERP,
      syncTouch: false,
      allowNestedScroll: true,
      // A link clicked mid-glide shouldn't carry the glide onto the next page.
      stopInertiaOnNavigate: true,
      respectReducedMotion: true,
      prevent: keepsNativeScroll,
    });

    const body = document.body;
    const followLock = () => {
      if (body.hasAttribute(SCROLL_LOCK_ATTRIBUTE)) lenis.stop();
      else lenis.start();
    };
    followLock();
    const observer = new MutationObserver(followLock);
    observer.observe(body, { attributes: true, attributeFilter: [SCROLL_LOCK_ATTRIBUTE] });

    return () => {
      observer.disconnect();
      lenis.destroy();
    };
  }, []);

  return null;
}
