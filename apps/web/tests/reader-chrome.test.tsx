import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRIP_CHROME_LINGER_MS, useReaderChrome } from '@/components/reader/use-reader-chrome';

const IDLE_MS = 2200;
const linger = () => act(() => void vi.advanceTimersByTime(STRIP_CHROME_LINGER_MS));
/** A mouse (or touch) pointer moving to `y` pixels from the top of the window. */
const pointerAt = (y: number, pointerType = 'mouse') =>
  act(() => {
    const event = new MouseEvent('pointermove', { clientY: y });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    window.dispatchEvent(event);
  });

type Options = Parameters<typeof useReaderChrome>[0];
const chrome = (options: Partial<Options> = {}) =>
  renderHook((props: Options) => useReaderChrome(props), {
    initialProps: { immersive: true, longStrip: false, hideChromeOnScroll: true, ...options },
  });
const idle = () => act(() => void vi.advanceTimersByTime(IDLE_MS));
const fire = (type: string) => act(() => void window.dispatchEvent(new Event(type)));

/** A pointer or focus event as the chrome's handlers receive it. */
const on = (target: Element) => ({ target, currentTarget: target, relatedTarget: null }) as never;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the reader chrome', () => {
  it('stays up when the reader is not immersive', () => {
    const { result } = chrome({ immersive: false });
    idle();
    expect(result.current.shown).toBe(true);
  });

  it('hides after a pause while immersive, and a key press brings it back', () => {
    const { result } = chrome();
    expect(result.current.shown).toBe(true);
    idle();
    expect(result.current.shown).toBe(false);
    fire('keydown');
    expect(result.current.shown).toBe(true);
    idle();
    expect(result.current.shown).toBe(false);
  });

  it('comes back for good when immersive is turned off', () => {
    const { result, rerender } = chrome();
    idle();
    expect(result.current.shown).toBe(false);
    rerender({ immersive: false, longStrip: false, hideChromeOnScroll: true });
    expect(result.current.shown).toBe(true);
  });

  it('ignores the pointer in a paged layout', () => {
    const { result } = chrome({ longStrip: false });
    idle();
    fire('mousemove');
    fire('touchstart');
    pointerAt(5);
    expect(result.current.shown).toBe(false);
  });

  it('in the long strip, shows only while the mouse rests on an edge, then goes 3s after', () => {
    const { result } = chrome({ longStrip: true });
    linger();
    expect(result.current.shown).toBe(false);

    // Moving over the page, scrolling with the keys, touching: none of these.
    pointerAt(window.innerHeight / 2);
    fire('mousemove');
    fire('touchstart');
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })));
    expect(result.current.shown).toBe(false);

    // The top edge brings the header, and it stays as long as the pointer does.
    pointerAt(10);
    expect(result.current.shown).toBe(true);
    linger();
    expect(result.current.shown).toBe(true);

    // Off the edge: still there just short of 3s, gone at 3s.
    pointerAt(window.innerHeight / 2);
    act(() => void vi.advanceTimersByTime(STRIP_CHROME_LINGER_MS - 100));
    expect(result.current.shown).toBe(true);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.shown).toBe(false);

    // The bottom edge does the same for the progress bar.
    pointerAt(window.innerHeight - 10);
    expect(result.current.shown).toBe(true);
  });

  it('ignores a touch pointer at the edge in the long strip', () => {
    const { result } = chrome({ longStrip: true });
    linger();
    pointerAt(10, 'touch');
    expect(result.current.shown).toBe(false);
  });

  it('reveals for Tab in the long strip, for a keyboard user heading to a control', () => {
    const { result } = chrome({ longStrip: true });
    linger();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })));
    expect(result.current.shown).toBe(true);
  });

  it('does not hide while a control is held, and does once it is let go', () => {
    const { result } = chrome();
    act(() => result.current.interaction.onPointerDown());
    idle();
    expect(result.current.shown).toBe(true);

    // A drag can finish anywhere; the next activity restarts the count.
    fire('pointerup');
    fire('keydown');
    idle();
    expect(result.current.shown).toBe(false);
  });

  it('counts a pointer over a button as using the controls, but not one over the empty bar', () => {
    const bar = document.createElement('div');
    const button = bar.appendChild(document.createElement('button'));

    const overBar = chrome();
    act(() => overBar.result.current.interaction.onPointerMove(on(bar)));
    idle();
    expect(overBar.result.current.shown).toBe(false);
    overBar.unmount();

    const overButton = chrome();
    act(() => overButton.result.current.interaction.onPointerMove(on(button)));
    idle();
    expect(overButton.result.current.shown).toBe(true);
  });

  it('hides on scrolling down and does not come back on scrolling up', () => {
    const { result } = chrome({ longStrip: true });
    act(() => result.current.onScrollDirection('down'));
    expect(result.current.shown).toBe(false);

    // The scroll itself moves the pointer; that must not undo the hide.
    fire('mousemove');
    fire('touchstart');
    expect(result.current.shown).toBe(false);

    act(() => result.current.onScrollDirection('up'));
    expect(result.current.shown).toBe(false);

    // Resting on an edge still brings it back after a scroll down hid it.
    pointerAt(10);
    expect(result.current.shown).toBe(true);
  });

  it('does not hide on a scroll caused from the controls themselves', () => {
    const { result } = chrome({ longStrip: true });
    act(() => result.current.interaction.onPointerEnter());
    act(() => result.current.onScrollDirection('down'));
    expect(result.current.shown).toBe(true);

    act(() => result.current.interaction.onPointerLeave());
    act(() => result.current.onScrollDirection('down'));
    expect(result.current.shown).toBe(false);
  });

  it('leaves scrolling alone when hide-on-scroll is off', () => {
    const { result } = chrome({ longStrip: true, hideChromeOnScroll: false });
    act(() => result.current.onScrollDirection('down'));
    expect(result.current.shown).toBe(true);
  });

  it('toggles from the tap zone', () => {
    const { result } = chrome();
    idle();
    act(() => result.current.toggle());
    expect(result.current.shown).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.shown).toBe(false);
  });
});
