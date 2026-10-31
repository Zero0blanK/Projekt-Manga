import axios from 'axios';
import type { ShelfStatus } from '@projekt-manga/types';
import { ValidationError } from '../../utils/customErrors.js';
import { requestWithRetry, toCredentialError, toTrackerError } from './httpRetry.js';
import type {
  TrackerAdapter,
  TrackerCredentials,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerRefreshResult,
  TrackerTokens,
} from './tracker.interface.js';

/**
 * Kitsu uses the OAuth2 *password* grant: the reader's email/username and password are
 * exchanged once for an access token (30 days) plus a refresh token, and the password is
 * dropped. Kitsu documents client_id/client_secret as not required for this grant, so the
 * tracker works with no server configuration; KITSU_CLIENT_ID/KITSU_CLIENT_SECRET are only
 * sent when an operator has registered an app of their own.
 *
 * The API is JSON:API (kitsu.app/api/edge) — every list comes back as `{ data: [...] }`
 * with fields under `attributes`.
 */

const TOKEN_URL = 'https://kitsu.app/api/oauth/token';
const API_BASE = 'https://kitsu.app/api/edge';
const JSON_API = 'application/vnd.api+json';

interface KitsuTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface KitsuLibraryEntry {
  id: string;
  attributes: {
    status: string;
    progress: number;
    ratingTwenty: number | null;
    updatedAt: string | null;
  };
}

export interface KitsuManga {
  id: string;
  attributes: {
    canonicalTitle: string;
    titles?: Record<string, string | null>;
    posterImage?: { small?: string | null; tiny?: string | null } | null;
  };
}

function clientFields(): Record<string, string> {
  const fields: Record<string, string> = {};
  if (process.env.KITSU_CLIENT_ID) fields.client_id = process.env.KITSU_CLIENT_ID;
  if (process.env.KITSU_CLIENT_SECRET) fields.client_secret = process.env.KITSU_CLIENT_SECRET;
  return fields;
}

async function postToken(fields: Record<string, string>, label: string, credentials: boolean) {
  try {
    const response = await requestWithRetry(() =>
      axios.post<KitsuTokenResponse>(
        TOKEN_URL,
        new URLSearchParams({ ...clientFields(), ...fields }),
        {
          timeout: 15000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      ),
    );
    return response.data;
  } catch (error) {
    if (credentials) toCredentialError(error, label);
    toTrackerError(error, label);
  }
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}`, Accept: JSON_API };
}

async function apiGet<T>(accessToken: string, path: string): Promise<T> {
  try {
    const response = await requestWithRetry(() =>
      axios.get<T>(`${API_BASE}${path}`, { timeout: 15000, headers: authHeaders(accessToken) }),
    );
    return response.data;
  } catch (error) {
    toTrackerError(error, 'Kitsu');
  }
}

async function apiWrite(
  method: 'post' | 'patch',
  accessToken: string,
  path: string,
  body: unknown,
): Promise<void> {
  try {
    await requestWithRetry(() =>
      axios[method](`${API_BASE}${path}`, body, {
        timeout: 15000,
        headers: { ...authHeaders(accessToken), 'Content-Type': JSON_API },
      }),
    );
  } catch (error) {
    toTrackerError(error, 'Kitsu');
  }
}

function expiresAt(expires_in: number | undefined): Date | null {
  return expires_in ? new Date(Date.now() + expires_in * 1000) : null;
}

async function getSelf(accessToken: string): Promise<{ id: string; name: string }> {
  const data = await apiGet<{ data: { id: string; attributes: { name: string } }[] }>(
    accessToken,
    '/users?filter[self]=true&fields[users]=name',
  );
  const self = data.data[0];
  if (!self) {
    throw new ValidationError("Kitsu didn't return the signed-in account");
  }
  return { id: self.id, name: self.attributes.name };
}

async function findEntry(
  accessToken: string,
  userId: string,
  mediaId: string,
): Promise<KitsuLibraryEntry | null> {
  const params = new URLSearchParams({
    'filter[userId]': userId,
    'filter[mangaId]': mediaId,
    'filter[kind]': 'manga',
    'fields[libraryEntries]': 'status,progress,ratingTwenty,updatedAt',
  });
  const data = await apiGet<{ data: KitsuLibraryEntry[] }>(
    accessToken,
    `/library-entries?${params.toString()}`,
  );
  return data.data[0] ?? null;
}

/** Updates the reader's library entry for this manga, creating it first if it isn't on
 * their Kitsu library yet (Kitsu has no upsert). */
async function saveEntry(
  accessToken: string,
  mediaId: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  const self = await getSelf(accessToken);
  const existing = await findEntry(accessToken, self.id, mediaId);
  if (existing) {
    await apiWrite('patch', accessToken, `/library-entries/${encodeURIComponent(existing.id)}`, {
      data: { id: existing.id, type: 'libraryEntries', attributes },
    });
    return;
  }
  await apiWrite('post', accessToken, '/library-entries', {
    data: {
      type: 'libraryEntries',
      attributes: { status: 'current', ...attributes },
      relationships: {
        user: { data: { id: self.id, type: 'users' } },
        manga: { data: { id: mediaId, type: 'manga' } },
      },
    },
  });
}

// --- mapping (pure, unit-tested against recorded fixtures) ---

export function mapKitsuSearch(data: { data: KitsuManga[] }): TrackerMediaSearchResult[] {
  return data.data.map((m) => ({
    tracker_media_id: m.id,
    title: m.attributes.titles?.en || m.attributes.canonicalTitle,
    cover_image_url: m.attributes.posterImage?.small ?? m.attributes.posterImage?.tiny ?? null,
  }));
}

export function mapKitsuEntry(entry: KitsuLibraryEntry | null): TrackerProgress | null {
  if (!entry) return null;
  const { status, progress, ratingTwenty, updatedAt } = entry.attributes;
  return {
    status,
    progress: progress ?? 0,
    // ratingTwenty is 2-20 in steps of 1 regardless of the account's display format.
    score: ratingTwenty ? ratingTwenty * 5 : null,
    updated_at: updatedAt ? new Date(updatedAt) : null,
  };
}

/** 0-100 → Kitsu's 2-20 ratingTwenty; 0 clears the rating. */
export function toKitsuRating(score: number): number | null {
  if (score <= 0) return null;
  return Math.min(20, Math.max(2, Math.round(score / 5)));
}

// --- adapter ---

const connectWithCredentials = async (credentials: TrackerCredentials): Promise<TrackerTokens> => {
  if (!credentials.username || !credentials.password) {
    throw new ValidationError('Kitsu needs your email (or username) and password');
  }
  const { access_token, refresh_token, expires_in } = await postToken(
    { grant_type: 'password', username: credentials.username, password: credentials.password },
    'Kitsu',
    true,
  );
  const self = await getSelf(access_token);
  return {
    access_token,
    refresh_token: refresh_token ?? null,
    expires_at: expiresAt(expires_in),
    tracker_user_id: self.id,
    tracker_username: self.name,
  };
};

const refreshTokens = async (refreshToken: string): Promise<TrackerRefreshResult> => {
  const { access_token, refresh_token, expires_in } = await postToken(
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    'Kitsu token',
    false,
  );
  return {
    access_token,
    refresh_token: refresh_token ?? null,
    expires_at: expiresAt(expires_in),
  };
};

const searchMedia = async (
  accessToken: string,
  query: string,
): Promise<TrackerMediaSearchResult[]> => {
  const params = new URLSearchParams({
    'filter[text]': query,
    'page[limit]': '10',
    'fields[manga]': 'canonicalTitle,titles,posterImage',
  });
  return mapKitsuSearch(
    await apiGet<{ data: KitsuManga[] }>(accessToken, `/manga?${params.toString()}`),
  );
};

const getProgress = async (
  accessToken: string,
  mediaId: string,
): Promise<TrackerProgress | null> => {
  const self = await getSelf(accessToken);
  return mapKitsuEntry(await findEntry(accessToken, self.id, mediaId));
};

const updateProgress = (accessToken: string, mediaId: string, progress: number) =>
  saveEntry(accessToken, mediaId, { progress });

const updateStatus = (accessToken: string, mediaId: string, status: string) =>
  saveEntry(accessToken, mediaId, { status });

const updateScore = (accessToken: string, mediaId: string, score: number) =>
  saveEntry(accessToken, mediaId, { ratingTwenty: toKitsuRating(score) });

const TO_SHELF: Record<string, ShelfStatus | undefined> = {
  current: 'READING',
  planned: 'PLAN',
  completed: 'COMPLETED',
  on_hold: 'ON_HOLD',
  dropped: 'DROPPED',
};
const FROM_SHELF: Record<ShelfStatus, string> = {
  READING: 'current',
  COMPLETED: 'completed',
  ON_HOLD: 'on_hold',
  PLAN: 'planned',
  DROPPED: 'dropped',
};

const kitsuTracker: TrackerAdapter = {
  label: 'Kitsu',
  authKind: 'password',
  isConfigured: () => true,
  connectWithCredentials,
  refreshTokens,
  searchMedia,
  getProgress,
  updateProgress,
  updateStatus,
  updateScore,
  mapToShelfStatus: (nativeStatus) => TO_SHELF[nativeStatus] ?? null,
  mapFromShelfStatus: (shelf) => FROM_SHELF[shelf],
};

export default kitsuTracker;
