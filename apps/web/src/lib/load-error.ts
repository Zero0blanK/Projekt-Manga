import { ApiError } from '@projekt-manga/api-client';

/**
 * Why something didn't load, in words the reader can act on, or null when there is
 * nothing more specific to say than the screen's own "couldn't load" line.
 *
 * The api-client's messages are already reader-facing for being offline, the server being
 * unreachable, a timeout, and anything the server explained itself. What it can't word
 * well is an expired sign-in, and a failure that didn't come from the API at all (a crashed
 * server or a proxy's error page), which only has a status code.
 */
export function describeLoadError(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.kind === 'aborted') return null;
  if (error.kind === 'http' && error.status === 401) {
    return 'Your sign-in has ended. Sign in again from Settings › Profile.';
  }
  if (error.kind === 'http' && /^Request failed with status \d+$/.test(error.message)) {
    return error.status >= 500
      ? 'The library server ran into a problem. Try again in a moment.'
      : null;
  }
  return error.message || null;
}
