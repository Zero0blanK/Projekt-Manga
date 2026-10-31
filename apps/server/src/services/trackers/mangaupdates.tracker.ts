import axios from 'axios';
import type { ShelfStatus } from '@projekt-manga/types';
import { ValidationError } from '../../utils/customErrors.js';
import { requestWithRetry, statusOf, toCredentialError, toTrackerError } from './httpRetry.js';
import type {
  TrackerAdapter,
  TrackerCredentials,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerTokens,
} from './tracker.interface.js';

/**
 * MangaUpdates (Baka-Updates) has no OAuth: `PUT /account/login` with the reader's
 * username and password returns a session token, used as a bearer token afterwards. The
 * password is not kept. The token has no documented expiry and there's no refresh grant,
 * so it's stored with `expires_at: null`; a revoked token surfaces as a 401 from the API
 * and the reader reconnects.
 *
 * A reader's list membership *is* their status: `list_id` 0 = reading, 1 = wish list,
 * 2 = complete, 3 = unfinished, 4 = on hold (custom lists have higher ids). The native
 * status string here is that id. The API exposes no per-entry modification time, so
 * `updated_at` is always null and status is pushed but never pulled.
 */

const API_BASE = 'https://api.mangaupdates.com/v1';

export interface MangaUpdatesSearchResponse {
  results: {
    record: {
      series_id: number;
      title: string;
      image?: { url?: { original?: string | null; thumb?: string | null } | null } | null;
    };
  }[];
}

export interface MangaUpdatesListEntry {
  series: { id: number; title?: string };
  list_id: number;
  status?: { volume?: number | null; chapter?: number | null } | null;
}

function headers(accessToken?: string) {
  return {
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function api<T>(
  method: 'get' | 'post' | 'put' | 'delete',
  accessToken: string,
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    const response = await requestWithRetry(() =>
      axios.request<T>({
        method,
        url: `${API_BASE}${path}`,
        data: body,
        timeout: 15000,
        headers: headers(accessToken),
      }),
    );
    return response.data;
  } catch (error) {
    toTrackerError(error, 'MangaUpdates');
  }
}

/** GET that treats 404 ("not on your list" / "not rated") as null rather than an error. */
async function getOrNull<T>(accessToken: string, path: string): Promise<T | null> {
  try {
    const response = await requestWithRetry(() =>
      axios.request<T>({
        method: 'get',
        url: `${API_BASE}${path}`,
        timeout: 15000,
        headers: headers(accessToken),
      }),
    );
    return response.data;
  } catch (error) {
    if (statusOf(error) === 404) return null;
    toTrackerError(error, 'MangaUpdates');
  }
}

function seriesId(mediaId: string): number {
  const id = Number(mediaId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ValidationError('Invalid MangaUpdates series id');
  }
  return id;
}

const getEntry = (accessToken: string, mediaId: string) =>
  getOrNull<MangaUpdatesListEntry>(
    accessToken,
    `/lists/series/${encodeURIComponent(String(seriesId(mediaId)))}`,
  );

/** Adds the series to the reader's lists (defaulting to "reading") or updates it if it's
 * already on one — MangaUpdates uses separate endpoints for the two. */
async function saveEntry(
  accessToken: string,
  mediaId: string,
  fields: { list_id?: number; status?: { chapter: number } },
): Promise<void> {
  const id = seriesId(mediaId);
  const existing = await getEntry(accessToken, mediaId);
  if (existing) {
    await api('post', accessToken, '/lists/series/update', [{ series: { id }, ...fields }]);
  } else {
    await api('post', accessToken, '/lists/series', [{ series: { id }, list_id: 0, ...fields }]);
  }
}

// --- mapping (pure, unit-tested against recorded fixtures) ---

export function mapMangaUpdatesSearch(
  data: MangaUpdatesSearchResponse,
): TrackerMediaSearchResult[] {
  return data.results.map(({ record }) => ({
    tracker_media_id: String(record.series_id),
    title: record.title,
    cover_image_url: record.image?.url?.thumb ?? record.image?.url?.original ?? null,
  }));
}

export function mapMangaUpdatesEntry(
  entry: MangaUpdatesListEntry | null,
  rating: { rating: number } | null,
): TrackerProgress | null {
  if (!entry) return null;
  return {
    status: String(entry.list_id),
    progress: Math.floor(entry.status?.chapter ?? 0),
    // Ratings are 1-10 with one decimal.
    score: rating && rating.rating > 0 ? Math.round(rating.rating * 10) : null,
    updated_at: null,
  };
}

// --- adapter ---

const connectWithCredentials = async (credentials: TrackerCredentials): Promise<TrackerTokens> => {
  const { username, password } = credentials;
  if (!username || !password) {
    throw new ValidationError('MangaUpdates needs your username and password');
  }
  let data: { context?: { session_token?: string; uid?: number } };
  try {
    const response = await requestWithRetry(() =>
      axios.put(
        `${API_BASE}/account/login`,
        { username, password },
        { timeout: 15000, headers: headers() },
      ),
    );
    data = response.data;
  } catch (error) {
    toCredentialError(error, 'MangaUpdates');
  }
  const token = data.context?.session_token;
  if (!token) {
    throw new ValidationError("MangaUpdates didn't accept those credentials.");
  }
  return {
    access_token: token,
    refresh_token: null,
    expires_at: null,
    tracker_user_id: String(data.context?.uid ?? username),
    tracker_username: username,
  };
};

const searchMedia = async (
  accessToken: string,
  query: string,
): Promise<TrackerMediaSearchResult[]> =>
  mapMangaUpdatesSearch(
    await api<MangaUpdatesSearchResponse>('post', accessToken, '/series/search', {
      search: query,
      stype: 'title',
      perpage: 10,
    }),
  );

const getProgress = async (
  accessToken: string,
  mediaId: string,
): Promise<TrackerProgress | null> => {
  const entry = await getEntry(accessToken, mediaId);
  if (!entry) return null;
  const rating = await getOrNull<{ rating: number }>(
    accessToken,
    `/series/${encodeURIComponent(String(seriesId(mediaId)))}/rating`,
  );
  return mapMangaUpdatesEntry(entry, rating);
};

const updateProgress = (accessToken: string, mediaId: string, progress: number) =>
  saveEntry(accessToken, mediaId, { status: { chapter: progress } });

const updateStatus = async (accessToken: string, mediaId: string, status: string) => {
  const list_id = Number(status);
  if (!Number.isInteger(list_id)) return;
  await saveEntry(accessToken, mediaId, { list_id });
};

const updateScore = async (accessToken: string, mediaId: string, score: number) => {
  const path = `/series/${encodeURIComponent(String(seriesId(mediaId)))}/rating`;
  if (score <= 0) {
    await api('delete', accessToken, path);
    return;
  }
  // 1-10 is the accepted range; 0-100 → one decimal place.
  await api('put', accessToken, path, { rating: Math.max(1, Math.round(score) / 10) });
};

const TO_SHELF: Record<string, ShelfStatus | undefined> = {
  '0': 'READING',
  '1': 'PLAN',
  '2': 'COMPLETED',
  '3': 'DROPPED',
  '4': 'ON_HOLD',
};
const FROM_SHELF: Record<ShelfStatus, string> = {
  READING: '0',
  PLAN: '1',
  COMPLETED: '2',
  DROPPED: '3',
  ON_HOLD: '4',
};

const mangaUpdatesTracker: TrackerAdapter = {
  label: 'MangaUpdates',
  authKind: 'password',
  isConfigured: () => true,
  connectWithCredentials,
  searchMedia,
  getProgress,
  updateProgress,
  updateStatus,
  updateScore,
  mapToShelfStatus: (nativeStatus) => TO_SHELF[nativeStatus] ?? null,
  mapFromShelfStatus: (shelf) => FROM_SHELF[shelf],
};

export default mangaUpdatesTracker;
