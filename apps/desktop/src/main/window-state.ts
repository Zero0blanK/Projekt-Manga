/**
 * Remembers the main window's size, position and maximized state between launches, in
 * a file beside the local database (the renderer's settings live in localStorage, which
 * the main process can't read before the window exists).
 */
import { app, screen, type BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseWindowState, restorableBounds, type Rect } from './window-bounds';

const SAVE_DELAY_MS = 500;

function stateFilePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** Bounds to open the main window at, or null for the default size, centred. Never
 * throws: a missing or corrupt file only means the window opens at its default. */
export function savedMainWindowBounds(minimum: { width: number; height: number }) {
  try {
    const saved = parseWindowState(JSON.parse(readFileSync(stateFilePath(), 'utf-8')));
    const bounds = restorableBounds(
      saved,
      screen.getAllDisplays().map((display) => display.workArea),
      minimum,
    );
    return bounds ? { bounds, maximized: saved?.maximized === true } : null;
  } catch {
    return null;
  }
}

/** Saves the window's state as it changes, and once more as it closes. The size kept is
 * the un-maximized one, so restoring from maximized still has somewhere to go back to. */
export function trackMainWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const bounds: Rect = win.getNormalBounds();
    try {
      writeFileSync(
        stateFilePath(),
        JSON.stringify({ ...bounds, maximized: win.isMaximized() }),
        'utf-8',
      );
    } catch (error) {
      console.warn('[window] Could not save the window position:', error);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const)
    win.on(event as 'resize', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
