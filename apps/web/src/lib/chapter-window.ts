'use client';

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

const ROW_HEIGHT = 72;
const OVERSCAN = 8;

export function useChapterWindow(count: number, filterKey: string) {
  const ref = useRef<HTMLUListElement>(null);
  const [windowRange, setWindowRange] = useState({ start: 0, end: 30 });
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    let frame = 0;
    const update = () => {
      const rows = Math.ceil(window.innerHeight / ROW_HEIGHT) + OVERSCAN * 2;
      const start = Math.min(
        Math.max(0, Math.floor(-list.getBoundingClientRect().top / ROW_HEIGHT) - OVERSCAN),
        Math.max(0, count - rows),
      );
      const end = Math.min(count, start + rows);
      setWindowRange((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [count, filterKey]);
  const start = Math.min(windowRange.start, Math.max(0, count - 1));
  const end = Math.min(count, Math.max(start + 1, windowRange.end));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowDown') next = Math.min(count - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    if (!ref.current || next < 0) return;
    event.preventDefault();
    const top = window.scrollY + ref.current.getBoundingClientRect().top + next * ROW_HEIGHT;
    const toolbar = document.querySelector<HTMLElement>('[aria-label="Selected chapter actions"]');
    const offset = (window.innerWidth < 640 ? 144 : 96) + (toolbar?.offsetHeight ?? 0) + 16;
    window.scrollTo({ top: Math.max(0, top - offset), behavior: 'instant' });
    const rows = Math.ceil(window.innerHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const nextStart = Math.max(0, next - OVERSCAN);
    setWindowRange({ start: nextStart, end: Math.min(count, nextStart + rows) });
    requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>(`[data-chapter-index="${next}"]`)?.focus(),
    );
  };
  return {
    ref,
    start,
    end,
    top: start * ROW_HEIGHT,
    bottom: (count - end) * ROW_HEIGHT,
    onKeyDown,
  };
}
