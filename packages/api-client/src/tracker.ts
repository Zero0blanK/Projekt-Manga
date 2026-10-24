import { request } from './client.js';
import type { LinkTrackerBody } from '@projekt-manga/schemas';

export type TrackerName = 'ANILIST' | 'MYANIMELIST';

export interface ConnectedTracker {
  tracker: TrackerName;
  tracker_username: string;
  connected_at: string;
}

export interface TrackerSearchResult {
  tracker_media_id: string;
  title: string;
  cover_image_url: string | null;
}

export interface TrackerLink {
  id: string;
  user_id: string;
  manga_id: string;
  tracker: TrackerName;
  tracker_media_id: string;
  sync_enabled: boolean;
  last_synced_at: string | null;
}

const trackerPath = (tracker: TrackerName) => tracker.toLowerCase();

export const getConnectedTrackers = (signal?: AbortSignal) =>
  request<ConnectedTracker[]>('/trackers', { signal });

/** Returns the URL to send the user's browser to — the caller does
 * `window.location.href = url` rather than this function redirecting itself, since a
 * fetch response can't navigate the page. */
export const getTrackerAuthorizeUrl = (tracker: TrackerName) =>
  request<{ url: string }>(`/trackers/${trackerPath(tracker)}/authorize`);

export const disconnectTracker = (tracker: TrackerName) =>
  request<null>(`/trackers/${trackerPath(tracker)}`, { method: 'DELETE' });

export interface TrackerSyncResult {
  checked: number;
  updated: number;
}

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
