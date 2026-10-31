/**
 * Goes to an app path from outside a link (the command palette, desktop menus). A path
 * that only changes the hash of the current page (another settings section) is applied
 * to `location.hash`, which is what the page listens to; the router's push would update
 * the address without telling it.
 */
export function goToAppPath(router: { push: (href: string) => void }, path: string) {
  const target = new URL(path, window.location.origin);
  if (target.pathname === window.location.pathname && target.hash) {
    window.location.hash = target.hash;
    return;
  }
  router.push(path);
}
