'use client';

import { useEffect, useRef, useState } from 'react';

export const AUTO_ADVANCE_SECONDS = 3;

/**
 * The paged reader's "continue to the next chapter" countdown. While `armed` (auto-advance
 * is on and the last page of `chapterKey` is showing) it counts down once a second and then
 * calls `onAdvance`; cancelling, or advancing, disarms it for that chapter so going back to
 * the last page doesn't start it again. Leaving the last page resets it.
 */
export function useAutoAdvanceCountdown(
  armed: boolean,
  chapterKey: string | undefined,
  onAdvance: () => void,
  seconds = AUTO_ADVANCE_SECONDS,
) {
  const [left, setLeft] = useState<{ key: string; seconds: number } | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  const advance = useRef(onAdvance);
  useEffect(() => {
    advance.current = onAdvance;
  });
  const active = armed && !!chapterKey && settled !== chapterKey;

  useEffect(() => {
    if (!active || !chapterKey) return;
    let remaining = seconds;
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setLeft({ key: chapterKey, seconds: remaining });
        return;
      }
      clearInterval(timer);
      setSettled(chapterKey);
      advance.current();
    }, 1000);
    return () => {
      clearInterval(timer);
      setLeft(null);
    };
  }, [active, chapterKey, seconds]);

  return {
    secondsLeft: active ? (left?.key === chapterKey ? left.seconds : seconds) : null,
    cancel: () => {
      if (chapterKey) setSettled(chapterKey);
    },
  };
}
