'use client';

import { useCallback, useEffect, useState } from 'react';

type Envelope<T> = { success: boolean; message: string; data?: T };
type WindowBridge = {
  getAlwaysOnTop: () => Promise<Envelope<boolean>>;
  setAlwaysOnTop: (enabled: boolean) => Promise<Envelope<boolean>>;
};

/** The desktop app's window controls; null in a plain browser. */
function windowBridge(): WindowBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { desktop?: { window?: WindowBridge } }).desktop?.window ?? null;
}

/** "Keep window on top" for the desktop reader. `available` is false in a browser, which
 * has no such control, so callers hide the option rather than offer one that can't work. */
export function useAlwaysOnTop() {
  const [available, setAvailable] = useState(false);
  const [onTop, setOnTop] = useState(false);
  useEffect(() => {
    const bridge = windowBridge();
    if (!bridge) return;
    setAvailable(true);
    void bridge
      .getAlwaysOnTop()
      .then((result) => setOnTop(result.data === true))
      .catch(() => undefined);
  }, []);
  const toggle = useCallback(() => {
    const bridge = windowBridge();
    if (!bridge) return;
    void bridge
      .setAlwaysOnTop(!onTop)
      .then((result) => setOnTop(result.data === true))
      .catch(() => undefined);
  }, [onTop]);
  return { available, onTop, toggle };
}
