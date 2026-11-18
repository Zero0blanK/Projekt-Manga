import { ApiError, getSourceMangaDetails, getSources } from '@projekt-manga/api-client';
import type { MangaDetails } from '@projekt-manga/types';
import { decodeSourceRouteId } from './source-route-id';

/** A source title, or why there isn't one to show. */
export type SourceTitleResult =
  | { status: 'found'; details: MangaDetails }
  /** The source answered and doesn't have it. */
  | { status: 'missing-title' }
  /** The source isn't installed (any more): an old link, or one from before it was removed. */
  | { status: 'missing-source' };

/**
 * Reads a title from its source for the preview and source-reader routes.
 *
 * The server refuses a source that isn't installed with a 503, the same status as a source
 * that is down, and production builds hide the message from the error page. So on a failure
 * this asks which sources are installed, to tell "removed" apart from "not answering". Any
 * other failure (or not being able to tell) is rethrown for the route's error page.
 */
export async function fetchSourceTitle(
  sourceId: string,
  routeMangaId: string,
): Promise<SourceTitleResult> {
  try {
    const details = await getSourceMangaDetails(sourceId, decodeSourceRouteId(routeMangaId));
    return { status: 'found', details };
  } catch (error) {
    if (!(error instanceof ApiError) || error.kind !== 'http') throw error;
    if (error.status === 404) return { status: 'missing-title' };
    if (await isUninstalled(sourceId)) return { status: 'missing-source' };
    throw error;
  }
}

async function isUninstalled(sourceId: string): Promise<boolean> {
  try {
    const sources = await getSources();
    return !sources.some((source) => source.id === sourceId);
  } catch {
    return false;
  }
}
