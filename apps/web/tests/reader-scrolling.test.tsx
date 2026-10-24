import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '@/lib/manga-data';
import { LongStripViewer } from '@/components/reader/long-strip-viewer';
import {
  autoScrollPixelsPerSecond,
  resolveScrollSpeed,
  DEFAULT_SCROLL_SPEED,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  AUTO_SCROLL_PIXELS_PER_SECOND,
} from '@/lib/reader-settings';

vi.mock('@/components/reader/manga-page', () => ({
  MangaPage: ({ pageNumber }: { pageNumber: number }) => <div>Page {pageNumber}</div>,
}));

const manga = {
  id: 'm1',
  slug: 'm1',
  title: 'Test manga',
  authors: [],
  artists: [],
  groups: null,
  source: 'fixture',
  chapters: 1,
  latestChapter: '1',
  latestChapterNum: 1,
  updatedAt: '',
  status: 'Ongoing',
  tags: [],
  color: '',
  accent: '',
  synopsis: '',
  rating: null,
  thumbnailUrl: null,
  inLibrary: true,
} satisfies Manga;

function ObserverStub() {
  return class {
    observe() {}
    disconnect() {}
  };
}

type StripProps = {
  onScrollDirection?: (direction: 'up' | 'down') => void;
  scrollSpeed?: number;
  autoScrollPixelsPerSecond?: number;
  zoom?: number;
};

function stripElement(props: StripProps = {}) {
  return (
    <LongStripViewer
      manga={manga}
      ready
      startChapter={1}
      startPage={1}
      getNextChapter={() => null}
      getChapterTitle={() => 'Chapter 1'}
      getChapterPageCount={() => 3}
      fetchPages={async () => ['a.png', 'b.png', 'c.png']}
      onPositionChange={() => undefined}
      {...props}
    />
  );
}

async function renderStrip(props: StripProps = {}) {
  const result = render(stripElement(props));
  // The viewer fetches its own pages; settling that here keeps the resulting state update
  // inside act rather than surfacing as a warning in every test.
  await act(async () => {});
  const strip = result.container.querySelector('.overflow-y-auto') as HTMLElement;
  expect(strip).toBeTruthy();
  return { ...result, strip };
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', ObserverStub());
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('scroll speed settings', () => {
  it('accepts a number, clamps it, and defaults to the browser step', () => {
    expect(resolveScrollSpeed(1.75)).toBe(1.75);
    expect(resolveScrollSpeed(99)).toBe(SCROLL_SPEED_MAX);
    expect(resolveScrollSpeed(0)).toBe(SCROLL_SPEED_MIN);
    // 1 is load-bearing, not cosmetic: the viewer uses it to decide not to intercept the
    // wheel at all, which is what preserves trackpad momentum and OS scroll settings.
    expect(resolveScrollSpeed(undefined)).toBe(DEFAULT_SCROLL_SPEED);
    expect(DEFAULT_SCROLL_SPEED).toBe(1);
  });

  it('still understands the Slow/Normal/Fast value it used to be stored as', () => {
    // The setting was once a three-way choice, so older stores may hold a string, and
    // reading that as a number gives NaN.
    expect(resolveScrollSpeed('Slow')).toBe(0.5);
    expect(resolveScrollSpeed('Normal')).toBe(1);
    expect(resolveScrollSpeed('Fast')).toBe(2);
    expect(resolveScrollSpeed('nonsense')).toBe(DEFAULT_SCROLL_SPEED);
  });

  it('clamps the auto-scroll speed to the rates it has, rather than extrapolating', () => {
    expect(autoScrollPixelsPerSecond(1)).toBe(AUTO_SCROLL_PIXELS_PER_SECOND[0]);
    expect(autoScrollPixelsPerSecond(AUTO_SCROLL_PIXELS_PER_SECOND.length)).toBe(
      AUTO_SCROLL_PIXELS_PER_SECOND.at(-1),
    );
    expect(autoScrollPixelsPerSecond(0)).toBe(AUTO_SCROLL_PIXELS_PER_SECOND[0]);
    expect(autoScrollPixelsPerSecond(99)).toBe(AUTO_SCROLL_PIXELS_PER_SECOND.at(-1));
  });
});

describe('long strip wheel handling', () => {
  it('leaves the wheel completely alone at the default speed', async () => {
    const { strip } = await renderStrip({ scrollSpeed: 1 });
    strip.scrollTop = 100;

    const event = new WheelEvent('wheel', { deltaY: 50, cancelable: true, bubbles: true });
    strip.dispatchEvent(event);

    // Not merely "the same distance" — untouched, so the browser's own smooth scrolling
    // and any accessibility setting on top of it still apply.
    expect(event.defaultPrevented).toBe(false);
    expect(strip.scrollTop).toBe(100);
  });

  it('scales the distance when a non-default speed is chosen', async () => {
    const { strip } = await renderStrip({ scrollSpeed: 2 });
    strip.scrollTop = 0;

    const event = new WheelEvent('wheel', { deltaY: 50, cancelable: true, bubbles: true });
    strip.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(strip.scrollTop).toBe(100);
  });

  it('does not hijack pinch-zoom or horizontal gestures', async () => {
    const { strip } = await renderStrip({ scrollSpeed: 2 });
    strip.scrollTop = 0;

    const zoom = new WheelEvent('wheel', {
      deltaY: 50,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    strip.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(false);

    const sideways = new WheelEvent('wheel', {
      deltaX: 80,
      deltaY: 4,
      cancelable: true,
      bubbles: true,
    });
    strip.dispatchEvent(sideways);
    expect(sideways.defaultPrevented).toBe(false);
    expect(strip.scrollTop).toBe(0);
  });
});

describe('hiding the reader chrome while scrolling', () => {
  it('reports down then up, and only once per change of direction', async () => {
    const onScrollDirection = vi.fn();
    const { strip } = await renderStrip({ onScrollDirection });

    strip.scrollTop = 400;
    fireEvent.scroll(strip);
    strip.scrollTop = 800;
    fireEvent.scroll(strip);
    expect(onScrollDirection.mock.calls.map(([d]) => d)).toEqual(['down']);

    strip.scrollTop = 400;
    fireEvent.scroll(strip);
    expect(onScrollDirection.mock.calls.map(([d]) => d)).toEqual(['down', 'up']);
  });

  it('ignores movement too small to be a deliberate direction change', async () => {
    const onScrollDirection = vi.fn();
    const { strip } = await renderStrip({ onScrollDirection });

    // A trackpad emits a stream of tiny deltas; reacting to each one makes the header
    // flicker rather than get out of the way.
    for (const top of [4, 9, 13, 18]) {
      strip.scrollTop = top;
      fireEvent.scroll(strip);
    }

    expect(onScrollDirection).not.toHaveBeenCalled();
  });

  it('never hides while still at the top of the chapter', async () => {
    const onScrollDirection = vi.fn();
    const { strip } = await renderStrip({ onScrollDirection });

    // Nudging down from the very top must not take the controls away: there is nothing
    // above to scroll back to in order to bring them back.
    strip.scrollTop = 20;
    fireEvent.scroll(strip);

    expect(onScrollDirection).not.toHaveBeenCalledWith('down');
  });
});

/** Drives rAF by hand so elapsed time is exact rather than whatever the machine managed. */
function frameDriver() {
  let now = 0;
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return {
    frames,
    /** Runs every frame queued so far, `ms` later. */
    advance(ms: number) {
      now += ms;
      const pending = frames.splice(0, frames.length);
      act(() => pending.forEach((frame) => frame(now)));
    },
  };
}

describe('scrolls the reader did not ask for', () => {
  it('does not report a direction when zooming reflows the strip', async () => {
    const onScrollDirection = vi.fn();
    const { strip, rerender } = await renderStrip({ onScrollDirection, zoom: 1 });
    strip.scrollTop = 600;
    fireEvent.scroll(strip);
    onScrollDirection.mockClear();

    // Zoom rescales scrollTop to keep the same art in view. That is the app moving the
    // page, and must not be read as a scroll down, or pressing zoom in the header would
    // hide the header that was just clicked.
    rerender(stripElement({ onScrollDirection, zoom: 2 }));
    fireEvent.scroll(strip);

    expect(onScrollDirection).not.toHaveBeenCalled();
  });

  it('does not report a direction while auto-scrolling', async () => {
    const driver = frameDriver();
    const onScrollDirection = vi.fn();
    const { strip } = await renderStrip({
      onScrollDirection,
      autoScrollPixelsPerSecond: 200,
    });
    strip.scrollTop = 600;
    fireEvent.scroll(strip);
    onScrollDirection.mockClear();

    driver.advance(0);
    driver.advance(200);
    fireEvent.scroll(strip);

    // Hands-free scrolling must not take the controls away — least of all the speed
    // slider that is sitting in them.
    expect(onScrollDirection).not.toHaveBeenCalled();
  });
});

describe('hands-free auto-scroll', () => {
  it('advances the strip over time at the configured rate', async () => {
    const driver = frameDriver();
    const { strip } = await renderStrip({ autoScrollPixelsPerSecond: 100 });
    expect(driver.frames.length).toBeGreaterThan(0);
    strip.scrollTop = 0;

    // The first frame only establishes the clock; the next moves by the elapsed time.
    driver.advance(0);
    driver.advance(200);

    expect(strip.scrollTop).toBe(20);
  });

  it('accumulates sub-pixel movement instead of stalling at the slowest speed', async () => {
    const driver = frameDriver();
    // 24px/s over a 16ms frame is 0.38px, and scrollTop only takes whole pixels — without
    // carrying the remainder between frames the slowest setting would never move at all.
    const { strip } = await renderStrip({ autoScrollPixelsPerSecond: 24 });
    expect(driver.frames.length).toBeGreaterThan(0);
    strip.scrollTop = 0;

    driver.advance(0);
    for (let i = 0; i < 10; i++) driver.advance(16);

    expect(strip.scrollTop).toBeGreaterThan(0);
  });

  it('does not lurch down the page after the tab was in the background', async () => {
    const driver = frameDriver();
    const { strip } = await renderStrip({ autoScrollPixelsPerSecond: 100 });
    expect(driver.frames.length).toBeGreaterThan(0);
    strip.scrollTop = 0;

    driver.advance(0);
    // Thirty seconds of no frames would be 3000px of catch-up without the clamp.
    driver.advance(30_000);

    expect(strip.scrollTop).toBe(25);
  });

  it('leaves the strip alone when it is not running', async () => {
    const driver = frameDriver();
    const { strip } = await renderStrip({ autoScrollPixelsPerSecond: 0 });
    strip.scrollTop = 0;

    // Other effects in the viewer use rAF too, so this drives whatever is queued and
    // checks the position rather than counting frames.
    driver.advance(0);
    driver.advance(1000);

    expect(strip.scrollTop).toBe(0);
  });
});

describe('reader chrome visibility ownership', () => {
  /**
   * If scrolling and the idle timer each set `chromeShown` on their own they fight:
   * scrolling back up reveals the bars and a timer still counting down from the last
   * mouse move hides them again a moment later, so auto-hide appears to stop bringing
   * them back.
   *
   * Modelled rather than mounting the reader, which needs a manga, chapters, a session
   * and a live viewer to render. The defect was entirely in who owns the timer.
   */
  function chromeController(idleMs: number) {
    let shown = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let engaged = false;
    const reveal = () => {
      shown = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (engaged) return;
        shown = false;
      }, idleMs);
    };
    const hide = () => {
      if (timer) clearTimeout(timer);
      shown = false;
    };
    return {
      reveal,
      hide,
      setEngaged: (value: boolean) => {
        engaged = value;
      },
      get shown() {
        return shown;
      },
    };
  }

  it('does not let a stale idle timer undo a reveal', () => {
    vi.useFakeTimers();
    const chrome = chromeController(2200);

    chrome.reveal(); // a mouse move, starting the countdown
    vi.advanceTimersByTime(1500);
    chrome.hide(); // scrolled down
    expect(chrome.shown).toBe(false);
    chrome.reveal(); // scrolled back up, well inside the original countdown

    vi.advanceTimersByTime(900); // the moment the first timer would have fired
    expect(chrome.shown).toBe(true);

    vi.advanceTimersByTime(1400); // its own countdown, measured from the reveal
    expect(chrome.shown).toBe(false);
  });

  it('never hides while a control is being used', () => {
    vi.useFakeTimers();
    const chrome = chromeController(2200);

    chrome.reveal();
    chrome.setEngaged(true);
    vi.advanceTimersByTime(5000);

    expect(chrome.shown).toBe(true);
  });
});
