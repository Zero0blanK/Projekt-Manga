'use client';

import { useEffect, useState } from 'react';

const SEEN_KEY = 'projekt-manga:tap-zones-hint-seen';

/** What a tap zone does, in the reader's own direction. */
function describe(action: string, rtl: boolean): string {
  if (action === 'Forward') return 'Next page';
  if (action === 'Back') return 'Previous page';
  if (action === 'Direction') return rtl ? 'Next page' : 'Previous page';
  if (action === 'Opposite') return rtl ? 'Previous page' : 'Next page';
  if (action === 'Controls') return 'Show controls';
  return 'Nothing';
}

/**
 * Shown once per browser on the first paged chapter: the three tap zones and what each
 * does under the reader's current settings, since nothing on screen otherwise says that
 * tapping the page turns it. Any tap, click or key dismisses it for good.
 */
export function TapZonesHint({
  tapActions,
  rtl,
}: {
  tapActions: { left: string; center: string; right: string };
  rtl: boolean;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) setShow(true);
    } catch {
      /* storage unavailable: skip the hint rather than show it every time */
    }
  }, []);
  useEffect(() => {
    if (!show) return;
    const dismiss = (event: Event) => {
      // The dismissing tap must not also turn the page underneath.
      if (event.type === 'pointerdown') event.stopPropagation();
      setShow(false);
      try {
        localStorage.setItem(SEEN_KEY, '1');
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pointerdown', dismiss, { once: true, capture: true });
    window.addEventListener('keydown', dismiss, { once: true });
    return () => {
      window.removeEventListener('pointerdown', dismiss, { capture: true });
      window.removeEventListener('keydown', dismiss);
    };
  }, [show]);
  if (!show) return null;
  const zones = [tapActions.left, tapActions.center, tapActions.right];
  return (
    <div
      role="note"
      aria-label="Reader tap zones"
      className="pointer-events-none absolute inset-0 z-40 grid grid-cols-3 bg-black/55 text-white"
    >
      {zones.map((action, index) => (
        <div
          key={index}
          className={`flex flex-col items-center justify-center gap-1 p-4 text-center ${index === 1 ? 'border-x border-dashed border-white/30' : ''}`}
        >
          <span className="text-sm font-semibold">{describe(action, rtl)}</span>
          <span className="text-[11px] text-white/60">
            {['Left', 'Middle', 'Right'][index]} third
          </span>
        </div>
      ))}
      <p className="absolute inset-x-0 bottom-8 text-center text-xs text-white/70">
        Tap anywhere to start reading · change zones in Settings → Reader
      </p>
    </div>
  );
}
