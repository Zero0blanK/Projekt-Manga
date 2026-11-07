import { buildApiUrl, request } from './client.js';
import type {
  ShelfStatus,
  LibraryState,
  UpdateLibraryStatePayload,
  ReleaseEstimate,
} from '@projekt-manga/types';
export type {
  ShelfStatus,
  LibraryState,
  UpdateLibraryStatePayload,
  ReleaseEstimate,
} from '@projekt-manga/types';

export const getLibraryState = (signal?: AbortSignal) =>
  request<LibraryState[]>('/library', { signal });

export const updateLibraryState = (mangaId: string, patch: UpdateLibraryStatePayload) =>
  request<LibraryState>(`/library/${encodeURIComponent(mangaId)}`, {
    method: 'PATCH',
    body: patch,
  });

/** Titles without enough release history are absent. Server-only: the desktop's local
 * database has no estimates, so callers treat a failure as "no estimates". */
export const getReleaseEstimates = (signal?: AbortSignal) =>
  request<ReleaseEstimate[]>('/library/release-estimates', { signal });

/**
 * Calls `onChange` whenever this library changes on the server, from this app or any other
 * on the same library (the desktop app and a browser, the same account on two devices).
 * Sends the session cookie so the server knows whose library to report. Returns an
 * unsubscribe function. Browser-only (relies on the global EventSource), which reconnects
 * on its own after a dropped connection.
 */
export function subscribeToLibraryChanges(
  onChange: (scope: 'library' | 'progress') => void,
): () => void {
  const source = new EventSource(buildApiUrl('/library-events/stream'), { withCredentials: true });
  source.addEventListener('change', (event) => {
    let scope: 'library' | 'progress' = 'library';
    try {
      if ((JSON.parse((event as MessageEvent).data) as { scope?: unknown }).scope === 'progress') {
        scope = 'progress';
      }
    } catch {
      // An unreadable frame still means something changed; refresh everything.
    }
    onChange(scope);
  });
  return () => source.close();
}
