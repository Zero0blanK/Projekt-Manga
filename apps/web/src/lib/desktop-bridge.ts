/**
 * The desktop app's preload bridge, or null in a plain browser.
 *
 * The one place the page reaches for `window.desktop`. The web app has to work without it, so
 * each caller names the part it uses and handles null, and every field stays optional: an
 * older desktop shell may not have a bridge this version of the page knows about.
 */
export function desktopBridge<Bridge>(): Partial<Bridge> | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { desktop?: Partial<Bridge> }).desktop ?? null;
}
