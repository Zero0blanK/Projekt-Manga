/**
 * Origins whose cookie jar can hold the account session cookie, in lookup order: the page's
 * own origin first, then the API's. A `*.localhost` page is served its API same-origin, so
 * the API origin is not a separate place to look. Shared by the IPC cookie read and the
 * sync runner's cookie clear, so both agree on where the session lives.
 */
export function sessionCookieOrigins(apiUrl: string, pageUrl?: string): string[] {
  const origins = [new URL(apiUrl).origin];
  if (pageUrl) {
    const page = new URL(pageUrl);
    if (page.hostname.endsWith('.localhost')) origins.length = 0;
    origins.unshift(page.origin);
  }
  return [...new Set(origins)];
}
