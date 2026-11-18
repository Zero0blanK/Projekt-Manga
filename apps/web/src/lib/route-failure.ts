import { ApiError } from '@projekt-manga/api-client';

/**
 * Why a route's error boundary caught `error`, as far as the page can tell.
 *
 * - `load`: fetching the page's data failed. Server-side errors arrive with only a `digest`
 *   (their message is stripped in production), and client-side fetches throw ApiError.
 * - `download`: part of the app's own code didn't download, which on a slow or dropped
 *   connection is the usual reason. Reloading fetches it again.
 * - `crash`: the page broke while showing what it had. Retrying rarely helps; it's a bug.
 */
export type RouteFailure = 'load' | 'download' | 'crash';

const CHUNK_FAILURE =
  /ChunkLoadError|Loading (CSS )?chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export function classifyRouteFailure(error: unknown): RouteFailure {
  if (error instanceof ApiError) return 'load';
  if (!(error instanceof Error)) return 'load';
  if (CHUNK_FAILURE.test(`${error.name} ${error.message}`)) return 'download';
  if (typeof (error as { digest?: unknown }).digest === 'string') return 'load';
  return 'crash';
}
