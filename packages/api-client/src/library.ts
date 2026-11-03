import { buildApiUrl, request } from './client.js';

export type ShelfStatus = 'READING' | 'COMPLETED' | 'ON_HOLD' | 'PLAN' | 'DROPPED';

export interface LibraryState {
  manga_id: string;
  is_bookmarked: boolean;
  shelf_status: ShelfStatus | null;
  /** Personal rating, 0-100. Absent entirely on the anonymous (no-account) path — the
   * shared manga_library table has no such column, since a rating only makes sense
   * per-account. */
  score?: number | null;
  notification_read: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpdateLibraryStatePayload {
  is_bookmarked?: boolean;
  shelf_status?: ShelfStatus | null;
  score?: number | null;
  notification_read?: boolean;
}

export const getLibraryState = (signal?: AbortSignal) =>
  request<LibraryState[]>('/library', { signal });

export const updateLibraryState = (mangaId: string, patch: UpdateLibraryStatePayload) =>
  request<LibraryState>(`/library/${encodeURIComponent(mangaId)}`, {
    method: 'PATCH',
    body: patch,
  });

/** When a library title's next chapter is expected, from its recent release cadence. */
export interface ReleaseEstimate {
  manga_id: string;
  interval_days: number;
  next_expected_at: string;
  last_chapter_at: string;
}

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
export function subscribeToLibraryChanges(onChange: () => void): () => void {
  const source = new EventSource(buildApiUrl('/library-events/stream'), { withCredentials: true });
  source.addEventListener('change', () => onChange());
  return () => source.close();
}
