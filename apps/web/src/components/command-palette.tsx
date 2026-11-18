'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const CommandPaletteDialog = dynamic(() => import('./command-palette-dialog'), { ssr: false });

/** Opens the palette from elsewhere (the desktop app menu). */
export const OPEN_COMMAND_PALETTE = 'projekt-manga:command-palette';
export const openCommandPalette = () => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE));

/**
 * Ctrl+Shift+P (Cmd+Shift+P): jump to a library title, a page or a settings section, or
 * run an action. Not Ctrl+K, which already focuses the search box. In the desktop app the
 * menu owns the key and opens this through the event above; in a browser it is caught
 * here.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  // The dialog's code downloads the first time it opens, then stays mounted so closing
  // can animate.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'p'
      ) {
        event.preventDefault();
        setLoaded(true);
        setOpen((value) => !value);
      }
    };
    const show = () => {
      setLoaded(true);
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE, show);
    };
  }, []);

  return loaded ? <CommandPaletteDialog open={open} setOpen={setOpen} /> : null;
}
