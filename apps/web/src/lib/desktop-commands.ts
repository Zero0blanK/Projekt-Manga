'use client';

/**
 * Commands from the desktop app's tray and application menu
 * (apps/desktop/src/main/renderer-commands.ts), and the taskbar progress the page reports
 * back. Absent in a plain browser, where every function here does nothing.
 */

export type DesktopCommand =
  | { type: 'navigate'; path: string }
  | { type: 'update-library' }
  | { type: 'command-palette' }
  | { type: 'open-pending' };

type CommandsBridge = { subscribe: (listener: (command: unknown) => void) => () => void };
type ProgressBridge = {
  setProgress: (fraction: number | null) => Promise<unknown>;
  setBadge?: (count: number, image?: string) => Promise<unknown>;
};

const desktop = () => desktopBridge<{ commands: CommandsBridge; window: ProgressBridge }>();

/** An app path the menus may open: one of this app's own pages, never another site. */
const APP_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/?#=&%]*$/;

/** Only commands this page knows, with a path that stays inside the app. */
export function parseDesktopCommand(raw: unknown): DesktopCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, path } = raw as Record<string, unknown>;
  if (type === 'update-library' || type === 'command-palette' || type === 'open-pending')
    return { type };
  if (type === 'navigate' && typeof path === 'string' && path.length <= 200 && APP_PATH.test(path))
    return { type, path };
  return null;
}

/** Listens for desktop commands; returns the unsubscribe function (a no-op in a browser). */
export function subscribeDesktopCommands(listener: (command: DesktopCommand) => void) {
  const bridge = desktop()?.commands;
  if (!bridge) return () => {};
  return bridge.subscribe((raw) => {
    const command = parseDesktopCommand(raw);
    if (command) listener(command);
  });
}

/** Progress on the taskbar button (dock icon on macOS): 0–1, or null to clear it. */
export function setTaskbarProgress(fraction: number | null) {
  void desktop()
    ?.window?.setProgress(fraction)
    .catch(() => undefined);
}

/** The badge Windows shows over the taskbar button: a filled dot with the count, "99+"
 * past 99. Drawn here because the desktop app's main process has no text rendering. */
function drawBadge(count: number): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.fillStyle = '#e5484d';
    context.beginPath();
    context.arc(16, 16, 15, 0, Math.PI * 2);
    context.fill();
    const label = count > 99 ? '99+' : String(count);
    context.fillStyle = '#fff';
    context.font = `bold ${label.length > 2 ? 12 : label.length > 1 ? 16 : 20}px system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, 16, 17);
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/** The number of titles with new chapters on the taskbar button (dock icon on macOS), or
 * 0 to clear it. Does nothing in a browser. */
export function setTaskbarBadge(count: number) {
  const bridge = desktop()?.window;
  if (!bridge?.setBadge) return;
  void bridge.setBadge(count, count > 0 ? drawBadge(count) : undefined).catch(() => undefined);
}
import { desktopBridge } from '@/lib/desktop-bridge';
