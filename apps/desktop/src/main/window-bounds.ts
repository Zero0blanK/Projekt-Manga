/**
 * Where the main window reopens. Pure, so the rule can be tested without Electron; the
 * reading and writing live in window-state.ts.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindowState extends Rect {
  maximized: boolean;
}

/** How much of the window's top edge must land on a screen for the saved position to be
 * reused: enough of the title bar to grab and drag it back. */
const GRAB_WIDTH = 120;
const GRAB_HEIGHT = 32;
/** Stored values beyond this are nonsense (or a hand-edited file), not a real display. */
const MAX_COORDINATE = 100_000;

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;

/** The stored state, or null when the file holds anything else. */
export function parseWindowState(raw: unknown): SavedWindowState | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height, maximized } = raw as Record<string, unknown>;
  if (![x, y, width, height].every(finite)) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number),
    maximized: maximized === true,
  };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * The bounds to reopen at, or null to let the window open centred at its default size.
 *
 * The saved position is kept only while its title bar is still on one of the current
 * screens' work areas: a monitor that was unplugged, or a resolution change, would
 * otherwise reopen the window somewhere it can't be reached. The size is capped to that
 * screen and kept at least the window's minimum.
 */
export function restorableBounds(
  saved: SavedWindowState | null,
  workAreas: readonly Rect[],
  minimum: { width: number; height: number },
): Rect | null {
  if (!saved) return null;
  const titleBar = { x: saved.x, y: saved.y, width: saved.width, height: GRAB_HEIGHT };
  const screen = workAreas.find((area) => {
    const shown = overlap(titleBar, area);
    return shown.width >= Math.min(GRAB_WIDTH, saved.width) && shown.height >= GRAB_HEIGHT / 2;
  });
  if (!screen) return null;
  return {
    x: saved.x,
    y: saved.y,
    width: Math.min(Math.max(saved.width, minimum.width), screen.width),
    height: Math.min(Math.max(saved.height, minimum.height), screen.height),
  };
}
