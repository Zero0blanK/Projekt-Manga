/**
 * The application menu. The window hides the menu bar (Alt shows it on Windows and
 * Linux; macOS always shows it in the top bar), so its main job is the keyboard
 * accelerators: Ctrl+Shift+P for the command palette, Ctrl+1–5 for the main pages, F11 for
 * fullscreen.
 */
import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { NAVIGATION_TARGETS, sendRendererCommand, type RendererCommand } from './renderer-commands';

/** To whichever app window has focus, or the main one. */
const send = (command: RendererCommand) => () =>
  sendRendererCommand(command, BrowserWindow.getFocusedWindow());
const go = (path: string) => send({ type: 'navigate', path });

export function buildAppMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Go',
      submenu: [
        { label: 'Library', accelerator: 'CmdOrCtrl+1', click: go(NAVIGATION_TARGETS.library) },
        { label: 'Discover', accelerator: 'CmdOrCtrl+2', click: go(NAVIGATION_TARGETS.discover) },
        { label: 'History', accelerator: 'CmdOrCtrl+3', click: go(NAVIGATION_TARGETS.history) },
        {
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+4',
          click: go(NAVIGATION_TARGETS.downloads),
        },
        { label: 'Upcoming', accelerator: 'CmdOrCtrl+5', click: go(NAVIGATION_TARGETS.upcoming) },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: go(NAVIGATION_TARGETS.settings) },
        { type: 'separator' },
        { label: 'Back', accelerator: 'Alt+Left', click: () => goHistory(-1) },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => goHistory(1) },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command palette…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: send({ type: 'command-palette' }),
        },
        { label: 'Update library', click: send({ type: 'update-library' }) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard shortcuts', click: go(NAVIGATION_TARGETS.shortcuts) },
        { label: 'About and diagnostics', click: go(NAVIGATION_TARGETS.about) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

function goHistory(step: -1 | 1): void {
  const contents = BrowserWindow.getFocusedWindow()?.webContents;
  if (!contents) return;
  if (step < 0 && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  if (step > 0 && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
}
