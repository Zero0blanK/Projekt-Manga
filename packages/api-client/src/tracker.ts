import { request } from './client.js';
import type { ConnectTrackerBody, LinkTrackerBody, TRACKER_SERVICES } from '@projekt-manga/schemas';
import type {
  TrackerName,
  TrackerAuthKind,
  TrackerAvailability,
  ConnectedTracker,
  TrackerSearchResult,
  TrackerLink,
  TrackerSyncResult,
} from '@projekt-manga/types';
export type {
  TrackerName,
  TrackerAuthKind,
  TrackerAvailability,
  ConnectedTracker,
  TrackerSearchResult,
  TrackerLink,
  TrackerSyncResult,
} from '@projekt-manga/types';

const trackerPath = (tracker: TrackerName) => tracker.toLowerCase();

export const getConnectedTrackers = (signal?: AbortSignal) =>
  request<ConnectedTracker[]>('/trackers', { signal });

/** Returns the URL to send the user's browser to — the caller does
 * `window.location.href = url` rather than this function redirecting itself, since a
 * fetch response can't navigate the page. */
export const getAvailableTrackers = (signal?: AbortSignal) =>
  request<TrackerAvailability[]>('/trackers/available', { signal });

/** For `password` and `api_key` trackers; OAuth trackers use getTrackerAuthorizeUrl. */
export const connectTrackerWithCredentials = (tracker: TrackerName, body: ConnectTrackerBody) =>
  request<ConnectedTracker>(`/trackers/${trackerPath(tracker)}/connect`, {
    method: 'POST',
    body,
  });

export const getTrackerAuthorizeUrl = (tracker: TrackerName) =>
  request<{ url: string }>(`/trackers/${trackerPath(tracker)}/authorize`);

export const disconnectTracker = (tracker: TrackerName) =>
  request<null>(`/trackers/${trackerPath(tracker)}`, { method: 'DELETE' });

/** Forces a sync of every link on this account, instead of waiting for the server's
 * 30-minute background cycle to reach them. Server-side capped, so this is safe to
 * expose as a button. */
export const syncTrackersNow = () =>
  request<TrackerSyncResult>('/trackers/sync', { method: 'POST' });

export const searchTrackerMedia = (tracker: TrackerName, query: string, signal?: AbortSignal) =>
  request<TrackerSearchResult[]>(`/trackers/${trackerPath(tracker)}/search`, {
    query: { query },
    signal,
  });

export const getMangaTrackerLinks = (manga_id: string, signal?: AbortSignal) =>
  request<TrackerLink[]>(`/manga/${encodeURIComponent(manga_id)}/tracker-link`, { signal });

export const linkMangaToTracker = (manga_id: string, body: LinkTrackerBody) =>
  request<TrackerLink>(`/manga/${encodeURIComponent(manga_id)}/tracker-link`, {
    method: 'POST',
    body,
  });

export const unlinkMangaFromTracker = (manga_id: string, tracker: TrackerName) =>
  request<null>(`/manga/${encodeURIComponent(manga_id)}/tracker-link/${trackerPath(tracker)}`, {
    method: 'DELETE',
  });
