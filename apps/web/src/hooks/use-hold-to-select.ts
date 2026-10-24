'use client';

import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

export function useHoldToSelect({
  onSelect,
  disabled = false,
}: {
  onSelect: () => void;
  disabled?: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const held = useRef(false);
  const select = useRef(onSelect);
  select.current = onSelect;
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pointer.current = null;
  };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', onKey);
    return () => {
      cancel();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      held.current = false;
      cancel();
      if (disabled || event.button !== 0 || !event.isPrimary) return;
      if (
        event.target instanceof Element &&
        event.target.closest('button, input, select, textarea, [role="menuitem"]')
      )
        return;
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        held.current = true;
        select.current();
      }, 450);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = pointer.current;
      if (
        start &&
        (event.pointerId !== start.id ||
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)
      )
        cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel() {
      held.current = false;
      cancel();
    },
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (!held.current) return;
      held.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (!disabled && event.key === ' ' && event.target === event.currentTarget) {
        event.preventDefault();
        if (!event.repeat) select.current();
      }
    },
  };
}
