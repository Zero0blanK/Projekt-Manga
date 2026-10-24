import type { ShelfStatus } from '@projekt-manga/types';
/**
 * The contract every tracker service (AniList, MyAnimeList) implements — keeping this
 * tracker-agnostic means adding a tracker is a new file behind this interface, not a
 * redesign of tracker.service.ts or the schema.
 */

export interface TrackerMediaSearchResult {
  tracker_media_id: string;
  title: string;
  cover_image_url: string | null;
}

export interface TrackerProgress {
  /** Tracker-native status string (e.g. AniList's CURRENT/COMPLETED/..., MAL's
   * reading/completed/...). Stored and compared as-is on the wire — use
   * mapToShelfStatus/mapFromShelfStatus to cross a tracker-agnostic boundary. */
  status: string;
  /** Chapters read, per the tracker's own count — always a plain integer, never tied to
   * a specific chapter id (see tracker.service.ts's push/pull logic for how this maps
   * onto this app's own per-chapter read state). */
  progress: number;
  /** Normalized to this app's own fixed 0-100 scale regardless of the tracker's native
   * scale (AniList's per-account scoreFormat, MAL's 0-10) — the adapter converts on the
   * way in and out so tracker.service.ts never needs to know about a specific tracker's
   * scoring format. Null means unscored on that tracker. */
  score: number | null;
  /** When the tracker itself last recorded a change to this entry (its own clock).
   * Anchors the status/score last-write-wins comparison against this app's
   * `user_manga_state.updated_at` — null when the tracker doesn't expose one, which
   * disables pulling status from that tracker rather than risking clobbering a local
   * edit with no way to tell which is newer. */
  updated_at: Date | null;
}

export interface TrackerTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: Date | null;
  tracker_user_id: string;
  tracker_username: string;
}

/** Slimmer than TrackerTokens: a refresh grant returns new credentials but not the
 * profile fields, which are already on file from the original exchangeCode call. */
export interface TrackerRefreshResult {
  access_token: string;
  refresh_token: string | null;
  expires_at: Date | null;
}

export interface TrackerAdapter {
  /** `codeVerifier` is PKCE bookkeeping (MyAnimeList requires it; AniList ignores it) —
   * generated and persisted by tracker.service.ts for every tracker uniformly so this
   * interface doesn't need a per-adapter "needsPkce" flag. */
  getAuthUrl(state: string, codeVerifier: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<TrackerTokens>;
  /** Omitted entirely by a tracker whose tokens can't be refreshed (AniList: long-lived,
   * no refresh grant at all) — tracker.service.ts falls back to asking the user to
   * reconnect once such a token expires, rather than calling a method that doesn't exist. */
  refreshTokens?(refreshToken: string): Promise<TrackerRefreshResult>;
  searchMedia(accessToken: string, query: string): Promise<TrackerMediaSearchResult[]>;
  getProgress(accessToken: string, mediaId: string): Promise<TrackerProgress | null>;
  updateProgress(accessToken: string, mediaId: string, progress: number): Promise<void>;
  updateStatus(accessToken: string, mediaId: string, status: string): Promise<void>;
  /** `score` is this app's normalized 0-100 scale — the adapter converts to whatever
   * native scale the tracker actually uses before sending it. */
  updateScore(accessToken: string, mediaId: string, score: number): Promise<void>;
  /** Normalizes this tracker's native status string to this app's shared ShelfStatus —
   * null for a native value with no reasonable local equivalent (e.g. AniList's
   * REPEATING has no "rereading" concept locally, so it's mapped to READING instead of
   * null, but an unrecognized/future value should return null rather than guess). */
  mapToShelfStatus(nativeStatus: string): ShelfStatus | null;
  mapFromShelfStatus(shelf: ShelfStatus): string;
}
