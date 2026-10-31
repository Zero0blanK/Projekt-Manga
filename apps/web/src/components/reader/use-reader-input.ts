'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useSetting } from '@/lib/app-store';
import {
  GAMEPAD_BINDINGS,
  MOUSE_BUTTON_BINDINGS,
  READER_KEY_BINDINGS,
  keyMap,
  keyName,
  parseKeyBindings,
  type ReaderAction,
} from '@/lib/reader-keys';

/** Return false when the action doesn't apply right now, so the key keeps its usual
 * meaning (the long strip's arrow keys, say). */
export type ReaderInputHandlers = Partial<Record<ReaderAction, () => boolean | void>>;

/** Where a key belongs to something other than the reader. */
function ignoredTarget(event: KeyboardEvent): boolean {
  if (document.querySelector('[role="dialog"]')) return true;
  const el = event.target instanceof Element ? event.target : null;
  // Lists with their own arrow and Home/End keys (the chapter list) keep all of them.
  if (
    el?.closest(
      'input,textarea,select,[contenteditable="true"],[role="menu"],[role="listbox"],[data-reader-keys-ignore]',
    )
  )
    return true;
  // A focused button or link stays usable from the keyboard: Space and Enter press it.
  // Other keys still reach the reader, because the control just clicked keeps focus.
  return (event.key === ' ' || event.key === 'Enter') && !!el?.closest('button,a');
}

/**
 * Keyboard, mouse back/forward buttons and gamepad for one part of the reader. Each
 * caller passes only the actions it owns (the viewer turns pages, the reader changes
 * chapters), so several can be mounted at once without stepping on each other.
 */
export function useReaderInput(handlers: ReaderInputHandlers, enabled = true) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const stored = useSetting(READER_KEY_BINDINGS, '');
  const keys = useMemo(() => keyMap(parseKeyBindings(stored)), [stored]);

  useEffect(() => {
    if (!enabled) return;
    const run = (action: ReaderAction | undefined) => {
      const handler = action && handlersRef.current[action];
      return handler ? handler() !== false : false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || ignoredTarget(event)) return;
      const name = keyName(event);
      if (name && run(keys.get(name))) event.preventDefault();
    };
    // Back/forward would otherwise navigate the browser away from the chapter. The
    // browser acts on mouseup, so both halves of the click are claimed.
    const onMouse = (event: MouseEvent) => {
      const action = MOUSE_BUTTON_BINDINGS.get(event.button);
      if (!action || !handlersRef.current[action]) return;
      event.preventDefault();
      if (event.type === 'mouseup') run(action);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [enabled, keys]);

  // Gamepads have no events for buttons, only a connect event: poll once a frame, and
  // only while one is connected, acting on the press (not while the button is held).
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    let frame = 0;
    const held = new Set<string>();
    const poll = () => {
      const pads = navigator.getGamepads().filter((pad): pad is Gamepad => !!pad);
      if (pads.length === 0) {
        frame = 0;
        return;
      }
      if (!document.querySelector('[role="dialog"]')) {
        for (const pad of pads)
          pad.buttons.forEach((button, index) => {
            const id = `${pad.index}:${index}`;
            if (!button.pressed) return void held.delete(id);
            if (held.has(id)) return;
            held.add(id);
            const action = GAMEPAD_BINDINGS.get(index);
            if (action) handlersRef.current[action]?.();
          });
      }
      frame = requestAnimationFrame(poll);
    };
    const start = () => {
      if (!frame) frame = requestAnimationFrame(poll);
    };
    window.addEventListener('gamepadconnected', start);
    if (navigator.getGamepads().some(Boolean)) start();
    return () => {
      window.removeEventListener('gamepadconnected', start);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled]);
}
