'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the reader chrome stays up after the last thing the reader did. */
const CHROME_IDLE_MS = 2200;

/**
 * Whether the reader's chrome (header and progress bar) is showing, and everything that
 * decides it: the idle timer while immersive, scrolling in the long strip, and a pointer
 * or focus resting on the controls themselves.
 *
 * The reader hands `interaction` to each chrome element, `onScrollDirection` to the long
 * strip and `toggle` to the tap zone, and renders by `shown`. It never sets visibility
 * itself, which is what keeps the timer and the scroll from fighting over it.
 */
export function useReaderChrome({
  immersive,
  longStrip,
  hideChromeOnScroll,
}: {
  /** Chrome auto-hides when idle. Off: it is always shown. */
  immersive: boolean;
  /** The long strip layout, where pointer and touch movement count as activity. */
  longStrip: boolean;
  /** Settings > Reader > Hide controls on scroll. */
  hideChromeOnScroll: boolean;
}) {
  const [chromeShown, setChromeShown] = useState(true);

  /**
   * Set while the reader is scrolling down, so the inactivity timer below does not
   * immediately undo the hide.
   *
   * Scrolling fires `mousemove` on some setups and `touchstart` on every phone, and both
   * of those mean "reveal" to the timer — without this the chrome would reappear a frame
   * after the scroll hid it, reading as a flicker.
   */
  const scrolledAway = useRef(false);

  /**
   * True while the pointer is over the reader chrome, or focus is inside it.
   *
   * Controls that move the page — zoom, the auto-scroll toggle, the speed sliders — are
   * *in* the bar they would otherwise dismiss. Hiding a control at the moment it is being
   * used is never what the reader meant, whatever the scroll position did.
   */
  const chromeHovered = useRef(false);
  /**
   * Actually *engaged* with the chrome: a pointer held down on it, or focus inside it.
   *
   * Narrower than hover on purpose. Hovering is enough to stop a scroll from dismissing
   * the bar — a click on zoom reflows the strip, and the pointer is still over the button
   * when that scroll event lands. It is not enough to stop the idle timer: a pointer
   * parked at the top of the screen is not someone using the controls, and treating it as
   * such would keep the bar up indefinitely.
   */
  const chromeEngaged = useRef(false);
  /** Hovering a control counts as engagement; hovering the bar's empty space does not. */
  const overControl = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('button, a, input, select, [role="slider"]');

  const chromeInteraction = {
    onPointerEnter: () => {
      chromeHovered.current = true;
    },
    // The bar is full-width, so a pointer parked at the top of the screen sits on it
    // without meaning anything by it. Poised over a button or a slider is different: that
    // one must not disappear as it is reached for.
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      chromeHovered.current = true;
      chromeEngaged.current = overControl(event.target);
    },
    onPointerLeave: () => {
      chromeHovered.current = false;
      chromeEngaged.current = false;
    },
    onPointerDown: () => {
      chromeEngaged.current = true;
    },
    onFocusCapture: () => {
      chromeEngaged.current = true;
    },
    onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        chromeEngaged.current = false;
      }
    },
  };

  // A drag can finish anywhere, including outside the bar it started in.
  useEffect(() => {
    const release = () => {
      chromeEngaged.current = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  /**
   * One owner of the chrome's visibility, and of the timer that hides it.
   *
   * Scrolling and the inactivity timer must not set `chromeShown` independently, or they
   * fight: scrolling back up reveals the bars and a timer still counting down from the
   * last mouse move hides them again a moment later. Every reveal restarts the timer and
   * every hide cancels it, so the last thing the reader did is the thing that decides.
   */
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const immersiveRef = useRef(immersive);
  immersiveRef.current = immersive;

  const revealChrome = useCallback(() => {
    setChromeShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!immersiveRef.current) return;
    hideTimer.current = setTimeout(() => {
      // Never mid-interaction — a slider being dragged, or focus sitting in the bar.
      if (chromeEngaged.current) return;
      setChromeShown(false);
    }, CHROME_IDLE_MS);
  }, []);

  const hideChrome = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setChromeShown(false);
  }, []);

  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  const onScrollDirection = useCallback(
    (direction: 'up' | 'down') => {
      if (!hideChromeOnScroll) return;
      if (direction === 'up') {
        scrolledAway.current = false;
        revealChrome();
        return;
      }
      // Scrolling down only hides when the reader is not at the controls. Hover counts
      // here: zoom reflows the strip, and the pointer is still on the button when that
      // scroll event arrives.
      if (chromeHovered.current || chromeEngaged.current) return;
      scrolledAway.current = true;
      hideChrome();
    },
    [hideChromeOnScroll, revealChrome, hideChrome],
  );

  /**
   * While immersive, the chrome auto-hides after a couple of seconds and comes back on
   * activity — but what counts as activity depends on the layout.
   *
   * In a paged layout nothing the reader does moves the page except paging itself, so
   * reacting to mouse movement would bring the bars back whenever the pointer crossed the
   * window, over the top of the page being read. There the tap zones are the control
   * surface (Settings > Reader > Tap zones, "Controls" by default on the centre third),
   * so after the first auto-hide the chrome stays put until something explicitly asks for
   * it. Key presses still reveal it: paging with the arrow keys is reading, and a
   * keyboard user has no tap zone.
   *
   * The long strip keeps pointer and touch reveals, because there scrolling is the
   * reading gesture and hide-on-scroll is what the chrome follows.
   */
  useEffect(() => {
    if (!immersive) {
      setChromeShown(true);
      return;
    }
    const reveal = () => {
      // Deliberately not clearing `scrolledAway`: only scrolling back up should do that,
      // or the first stray mouse move would cancel the hide.
      if (scrolledAway.current) return;
      revealChrome();
    };
    reveal();
    window.addEventListener('keydown', reveal);
    if (longStrip) {
      window.addEventListener('mousemove', reveal);
      window.addEventListener('touchstart', reveal);
    }
    return () => {
      window.removeEventListener('keydown', reveal);
      window.removeEventListener('mousemove', reveal);
      window.removeEventListener('touchstart', reveal);
    };
  }, [immersive, longStrip, revealChrome]);

  const toggle = useCallback(() => setChromeShown((value) => !value), []);

  return {
    shown: chromeShown,
    /** Spread onto every element that is part of the chrome. */
    interaction: chromeInteraction,
    /** From the long strip: which way the reader just scrolled. */
    onScrollDirection,
    /** The tap zone's "Controls" action. */
    toggle,
  };
}
