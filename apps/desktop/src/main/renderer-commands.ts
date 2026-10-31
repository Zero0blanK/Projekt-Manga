/**
 * Commands the main process sends to the app window, from places that have no page of
 * their own: the tray menu and the application menu. One fixed set, so the renderer only
 * ever acts on commands it knows (see apps/web/src/lib/desktop-commands.ts).
 */
import type { BrowserWindow } from 'electron';

export const RENDERER_COMMAND_CHANNEL = 'desktop:command';

export type RendererCommand =
  | { type: 'navigate'; path: string }
  | { type: 'update-library' }
  | { type: 'command-palette' }
  /** A comic was opened from outside (Open with, a drop): collect it. */
  | { type: 'open-pending' };

/** Pages the menus may navigate to. Fixed here rather than taken from anywhere else. */
export const NAVIGATION_TARGETS = {
  library: '/',
  discover: '/discover',
  history: '/history',
  downloads: '/downloads',
  upcoming: '/upcoming',
  settings: '/settings',
  shortcuts: '/settings#shortcuts',
  about: '/settings#about',
} as const;

let mainWindow: BrowserWindow | null = null;

/** The window the tray and app menu talk to (extra windows opened from links don't count). */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** Sends to the focused app window, or the main one when none is focused (the tray). */
export function sendRendererCommand(command: RendererCommand, target?: BrowserWindow | null) {
  const win = target && !target.isDestroyed() ? target : getMainWindow();
  win?.webContents.send(RENDERER_COMMAND_CHANNEL, command);
}
