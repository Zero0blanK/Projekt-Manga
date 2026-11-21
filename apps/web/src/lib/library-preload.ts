import { buildApiUrl } from '@projekt-manga/api-client';

/** About two screens of covers: enough to fill the first view before the rest arrives. */
export const FIRST_LIBRARY_PAGE = 60;

/**
 * Starts downloading the library's first page with the page itself.
 *
 * The library is asked for only once the app's code has downloaded and run, which on a
 * slow connection is most of the wait: on Slow 3G the code took 14s, then the library
 * another 4s on top. This script runs as the HTML arrives and has the browser fetch the
 * first page alongside the code, so it is there when the app asks for it. The app's own
 * request (lib/library-store.ts) matches this URL and credentials exactly, which is what
 * lets the browser hand it the preloaded response.
 *
 * It sits in the root layout, which every page loads, so it acts only when the page being
 * opened is the library itself.
 *
 * Browser only: the desktop app reads its library from its own database.
 */
export const libraryPreloadScript = () =>
  `(function(){try{if(window.desktop||location.pathname!=='/')return;var l=document.createElement('link');l.rel='preload';l.as='fetch';l.crossOrigin='use-credentials';l.href=${scriptString(
    buildApiUrl('/manga', { limit: FIRST_LIBRARY_PAGE, offset: 0 }),
  )};document.head.appendChild(l);}catch(e){}})();`;

/**
 * `value` as a JavaScript string literal that is safe inside an inline <script>. JSON alone
 * isn't: a `</script>` or `<!--` in it would end or break the element. Every character that
 * can do that is written as an escape, which reads back as the same string.
 */
export function scriptString(value: string): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
