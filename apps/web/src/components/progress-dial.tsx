'use client';

import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Circumference of the ring below, for the stroke-dash trick that draws the arc. */
const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** How far a swipe travels, in any direction, before it minimizes on release. */
const SWIPE_DISTANCE = 40;
/** Movement under this is a tap that wobbled, not a swipe. */
const TAP_SLOP = 8;
/** Kept for the session: a dial leaves the screen between runs and on some pages, and
 * shouldn't open back up each time it returns. */
const minimizedDials = new Set<string>();

/**
 * Long-running progress in the bottom-right corner, with its details beside the ring. A
 * swipe in any direction, or a press on the ring, shrinks it to the ring alone; pressing
 * the ring brings the details back.
 */
export function ProgressDial({
  id,
  name,
  fraction,
  status,
  detail,
  onStop,
  stopLabel,
}: {
  id: string;
  /** What it reports on, for the ring's label: "library update". */
  name: string;
  fraction: number;
  /** Announced as it changes, and stays announced while minimized. */
  status: ReactNode;
  detail?: string;
  onStop?: () => void;
  stopLabel?: string;
}) {
  const [minimized, setMinimizedState] = useState(() => minimizedDials.has(id));
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  const setMinimized = (next: boolean) => {
    if (next) minimizedDials.add(id);
    else minimizedDials.delete(id);
    setMinimizedState(next);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swiped.current = false;
    if (minimized || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-no-swipe]')) return;
    start.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const x = event.clientX - start.current.x;
    const y = event.clientY - start.current.y;
    if (!swiped.current && Math.hypot(x, y) < TAP_SLOP) return;
    // Captured only now: capturing on press would take a tap's click away from the ring.
    if (!swiped.current) event.currentTarget.setPointerCapture?.(event.pointerId);
    swiped.current = true;
    setOffset({ x, y });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    start.current = null;
    setOffset(null);
    if (!from || !swiped.current) return;
    if (Math.hypot(event.clientX - from.x, event.clientY - from.y) >= SWIPE_DISTANCE)
      setMinimized(true);
  };
  const onPointerCancel = () => {
    start.current = null;
    setOffset(null);
  };

  const percent = Math.round(fraction * 100);
  const distance = offset ? Math.hypot(offset.x, offset.y) : 0;
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={
        offset
          ? {
              transform: `translate(${offset.x}px, ${offset.y}px)`,
              opacity: Math.max(0.4, 1 - distance / 200),
            }
          : undefined
      }
      className={`pointer-events-auto flex touch-none select-none items-center gap-3 border border-border/60 bg-popover/95 shadow-xl shadow-black/30 backdrop-blur ${
        minimized ? 'rounded-full p-1' : 'rounded-2xl p-3'
      } ${offset ? '' : 'transition-transform duration-200'}`}
    >
      <button
        type="button"
        aria-expanded={!minimized}
        aria-label={minimized ? `Show ${name} details` : `Minimize ${name}`}
        onClick={() => {
          // The click that ends a swipe which began on the ring.
          if (!swiped.current) setMinimized(!minimized);
        }}
        className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-primary"
      >
        <svg className="h-11 w-11 -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
          <circle cx="22" cy="22" r={RADIUS} fill="none" strokeWidth="3" className="stroke-muted" />
          <circle
            cx="22"
            cy="22"
            r={RADIUS}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            className="stroke-primary transition-[stroke-dashoffset] duration-300"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          />
        </svg>
        {/* tabular-nums so the number does not jitter the ring as it counts up. */}
        <span className="absolute text-[10px] font-semibold tabular-nums text-foreground">
          {percent}%
        </span>
      </button>

      <div className={minimized ? 'sr-only' : 'min-w-0'}>
        {/* One live region for the whole thing: announcing the ring and the caption
            separately would read the same update twice. */}
        <p role="status" className="text-xs font-medium text-foreground">
          {status}
        </p>
        {detail && (
          <p className="mt-0.5 max-w-[14rem] truncate text-xs text-muted-foreground">{detail}</p>
        )}
      </div>

      {onStop && !minimized && (
        <button
          type="button"
          data-no-swipe
          onClick={onStop}
          aria-label={stopLabel}
          title="Stop"
          className="grid h-7 w-7 pointer-coarse:size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
