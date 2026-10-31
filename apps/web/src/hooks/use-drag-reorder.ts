'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

/** Movement before a press becomes a drag, so a click stays a click. */
const DRAG_THRESHOLD = 5;
/** How close to the scroll area's edge the pointer must be to scroll it, and how fast. */
const EDGE = 48;
const SCROLL_STEP = 14;

type Box = { top: number; height: number };
type Session = {
  id: string;
  from: number;
  pointer: number;
  startX: number;
  startY: number;
  lastY: number;
  listTop: number;
  boxes: Box[];
  active: boolean;
  scroller: HTMLElement | null;
  frame: number;
  stop: () => void;
};

function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (/(auto|scroll)/.test(overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/** Moves the visible ids to their new order within the full order, leaving the rest where
 * they were (for a list filtered down to some of its rows). */
export function mergeVisibleOrder(full: string[], visible: string[]): string[] {
  const shown = new Set(visible);
  let next = 0;
  return full.map((id) => (shown.has(id) ? visible[next++] : id));
}

/**
 * Pick-up-and-carry reordering for a vertical list. The pressed row follows the pointer,
 * the rows it passes slide aside to show where it will land, and the new order is only
 * committed on release. Rows carry `data-drag-id`; the list element takes `listRef`.
 */
export function useDragReorder<T extends HTMLElement>({
  ids,
  onReorder,
  disabled = false,
}: {
  ids: string[];
  onReorder: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const listRef = useRef<T>(null);
  const session = useRef<Session | null>(null);
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; dy: number } | null>(
    null,
  );
  const suppressClick = useRef(false);
  const latest = useRef({ ids, onReorder });
  latest.current = { ids, onReorder };

  useEffect(() => () => session.current?.stop(), []);

  const place = (current: Session) => {
    const list = listRef.current;
    if (!list) return;
    const box = current.boxes[current.from];
    const last = current.boxes[current.boxes.length - 1];
    // The list may have scrolled since the press; boxes are in list coordinates.
    const scrolled = current.listTop - list.getBoundingClientRect().top;
    const dy = Math.min(
      Math.max(current.lastY - current.startY + scrolled, -box.top),
      last.top + last.height - box.top - box.height,
    );
    const centre = box.top + dy + box.height / 2;
    const to = current.boxes.filter(
      (other, index) => index !== current.from && other.top + other.height / 2 < centre,
    ).length;
    setDrag({ id: current.id, from: current.from, to, dy });
  };

  const autoScroll = (current: Session) => {
    current.frame = requestAnimationFrame(() => autoScroll(current));
    if (!current.active) return;
    const top = current.scroller ? current.scroller.getBoundingClientRect().top : 0;
    const bottom = current.scroller
      ? current.scroller.getBoundingClientRect().bottom
      : window.innerHeight;
    const step =
      current.lastY < top + EDGE ? -SCROLL_STEP : current.lastY > bottom - EDGE ? SCROLL_STEP : 0;
    if (!step) return;
    if (current.scroller) current.scroller.scrollTop += step;
    else window.scrollBy({ top: step });
    place(current);
  };

  const start = (id: string, event: PointerEvent<HTMLElement>) => {
    const list = listRef.current;
    if (disabled || !list || event.button !== 0 || !event.isPrimary || session.current) return;
    const rows = latest.current.ids.map((rowId) =>
      list.querySelector<HTMLElement>(`[data-drag-id="${CSS.escape(rowId)}"]`),
    );
    const from = latest.current.ids.indexOf(id);
    if (from < 0 || rows.some((row) => !row)) return;
    const listTop = list.getBoundingClientRect().top;
    suppressClick.current = false;
    const current: Session = {
      id,
      from,
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      listTop,
      boxes: rows.map((row) => {
        const rect = row!.getBoundingClientRect();
        return { top: rect.top - listTop, height: rect.height };
      }),
      active: false,
      scroller: scrollParent(list),
      frame: 0,
      stop: () => {},
    };
    const move = (moved: globalThis.PointerEvent) => {
      if (moved.pointerId !== current.pointer) return;
      current.lastY = moved.clientY;
      if (!current.active) {
        if (
          Math.hypot(moved.clientX - current.startX, moved.clientY - current.startY) <
          DRAG_THRESHOLD
        )
          return;
        current.active = true;
      }
      moved.preventDefault();
      place(current);
    };
    const finish = (ended: globalThis.PointerEvent, commit: boolean) => {
      if (ended.pointerId !== current.pointer) return;
      current.stop();
      if (!current.active) return;
      suppressClick.current = true;
      const list = listRef.current;
      if (!commit || !list) return;
      const box = current.boxes[current.from];
      const scrolled = current.listTop - list.getBoundingClientRect().top;
      const centre = box.top + current.lastY - current.startY + scrolled + box.height / 2;
      const to = current.boxes.filter(
        (other, index) => index !== current.from && other.top + other.height / 2 < centre,
      ).length;
      if (to === current.from) return;
      const next = [...latest.current.ids];
      next.splice(current.from, 1);
      next.splice(to, 0, current.id);
      latest.current.onReorder(next);
    };
    const up = (ended: globalThis.PointerEvent) => finish(ended, true);
    const cancel = (ended: globalThis.PointerEvent) => finish(ended, false);
    current.stop = () => {
      cancelAnimationFrame(current.frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      session.current = null;
      setDrag(null);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    session.current = current;
    autoScroll(current);
  };

  /** Where each row is drawn while a drag is under way. */
  const itemStyle = (id: string): CSSProperties | undefined => {
    const current = session.current;
    if (!drag || !current) return undefined;
    const index = latest.current.ids.indexOf(id);
    if (id === drag.id)
      return {
        transform: `translateY(${drag.dy}px) scale(1.02)`,
        position: 'relative',
        zIndex: 10,
        transition: 'box-shadow 150ms',
        boxShadow: '0 10px 24px -8px rgb(0 0 0 / 0.35)',
      };
    const { boxes, from } = current;
    // The space the lifted row leaves, including any gap below it.
    const space =
      from + 1 < boxes.length
        ? boxes[from + 1].top - boxes[from].top
        : from > 0
          ? boxes[from].top - boxes[from - 1].top
          : boxes[from].height;
    const shift =
      from < drag.to && index > from && index <= drag.to
        ? -space
        : drag.to < from && index >= drag.to && index < from
          ? space
          : 0;
    return { transform: `translateY(${shift}px)`, transition: 'transform 160ms ease' };
  };

  /** A row's place in the order it will have if dropped now, from 0. */
  const position = (id: string) => {
    const ids = latest.current.ids;
    if (!drag) return ids.indexOf(id);
    const next = ids.filter((other) => other !== drag.id);
    next.splice(drag.to, 0, drag.id);
    return next.indexOf(id);
  };

  return {
    listRef,
    position,
    /** The id being carried, or null. */
    dragging: drag?.id ?? null,
    start,
    itemStyle,
    /** True once after a drag, so the release does not also click the row. */
    takeSuppressedClick: () => {
      const value = suppressClick.current;
      suppressClick.current = false;
      return value;
    },
  };
}
