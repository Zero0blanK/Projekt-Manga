/**
 * Body attribute Radix's dialogs and sheets (react-remove-scroll-bar) set while they lock
 * the page. Smooth page scrolling pauses for as long as it's there, so the page behind a
 * dialog can't be wheeled.
 */
export const SCROLL_LOCK_ATTRIBUTE = 'data-scroll-locked';

/**
 * What keeps its own scrolling: anything marked `data-lenis-prevent`, and the floating
 * layers (dialogs, menus, lists, popovers) that sit over the page in portals.
 */
const NATIVE_SCROLL_SELECTOR = [
  '[data-lenis-prevent]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
].join(',');

export function keepsNativeScroll(node: HTMLElement): boolean {
  return node.closest?.(NATIVE_SCROLL_SELECTOR) != null;
}
