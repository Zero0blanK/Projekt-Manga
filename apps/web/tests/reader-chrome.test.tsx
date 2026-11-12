import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReaderChrome } from '@/components/reader/use-reader-chrome';

const IDLE_MS = 2200;

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

  it('ignores the pointer in a paged layout and follows it in the long strip', () => {
    const paged = chrome({ longStrip: false });
    idle();
    fire('mousemove');
    fire('touchstart');
    expect(paged.result.current.shown).toBe(false);
    paged.unmount();

    const strip = chrome({ longStrip: true });
    idle();
    expect(strip.result.current.shown).toBe(false);
    fire('mousemove');
    expect(strip.result.current.shown).toBe(true);
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

  it('hides on scrolling down and returns only on scrolling back up', () => {
    const { result } = chrome({ longStrip: true });
    act(() => result.current.onScrollDirection('down'));
    expect(result.current.shown).toBe(false);

    // The scroll itself moves the pointer; that must not undo the hide.
    fire('mousemove');
    fire('touchstart');
    expect(result.current.shown).toBe(false);

    act(() => result.current.onScrollDirection('up'));
    expect(result.current.shown).toBe(true);
    idle();
    fire('mousemove');
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
