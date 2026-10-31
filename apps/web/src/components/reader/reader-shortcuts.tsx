'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSetting } from '@/lib/app-store';
import { READER_ACTIONS, READER_KEY_BINDINGS, keyLabel, parseKeyBindings } from '@/lib/reader-keys';
import { useReaderInput } from '@/components/reader/use-reader-input';

/** Fullscreen through the browser's API, which also takes the desktop window fullscreen. */
export function toggleFullscreen() {
  if (typeof document === 'undefined') return;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void document.documentElement.requestFullscreen?.().catch(() => undefined);
}

/** Opens the shortcut sheet from elsewhere in the reader (its right-click menu). */
export const OPEN_READER_SHORTCUTS = 'projekt-manga:reader-shortcuts';
export const openReaderShortcuts = () => window.dispatchEvent(new Event(OPEN_READER_SHORTCUTS));

/** Inputs that aren't rebindable keys, listed so the sheet tells the whole story. */
const FIXED_INPUTS: Array<[string, string]> = [
  ['Esc', 'Leave the reader (or close the open panel)'],
  ['Right-click', 'Page menu: save, copy, fullscreen'],
  ['Mouse back / forward', 'Previous / next page'],
  ['Double-click', 'Zoom in at the cursor, or back out'],
  ['Ctrl + wheel', 'Zoom'],
  ['Gamepad d-pad / shoulders', 'Turn pages / change chapter'],
];

/**
 * Handles the reader-wide keys every reader shares (fullscreen and the shortcut sheet)
 * and renders the sheet. Mount once per reader.
 */
export function ReaderShortcuts() {
  const [open, setOpen] = useState(false);
  const bindings = parseKeyBindings(useSetting(READER_KEY_BINDINGS, ''));
  useReaderInput({
    shortcuts: () => setOpen(true),
    fullscreen: toggleFullscreen,
  });
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_READER_SHORTCUTS, show);
    return () => window.removeEventListener(OPEN_READER_SHORTCUTS, show);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Change them in Settings › Reader › Keyboard.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
          {READER_ACTIONS.map(({ id, label }) => (
            <div key={id} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="flex flex-wrap justify-end gap-1">
                {bindings[id].length === 0 ? (
                  <span className="text-xs text-muted-foreground">Not set</span>
                ) : (
                  bindings[id].map((key) => (
                    <kbd
                      key={key}
                      className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs"
                    >
                      {keyLabel(key)}
                    </kbd>
                  ))
                )}
              </dd>
            </div>
          ))}
          {FIXED_INPUTS.map(([input, effect]) => (
            <div key={input} className="contents">
              <dt className="text-muted-foreground">{effect}</dt>
              <dd className="text-right text-xs">{input}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
