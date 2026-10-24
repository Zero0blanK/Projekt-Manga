import axios from 'axios';
import type { ShelfStatus } from '@projekt-manga/types';
import { ServiceUnavailableError } from '../../utils/customErrors.js';
import { requestWithRetry, toTrackerError } from './httpRetry.js';
import type {
  TrackerAdapter,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerTokens,
  TrackerRefreshResult,
} from './tracker.interface.js';

/**
 * MyAnimeList requires MAL to approve an API application before it works at all — this
 * adapter is only reachable once MAL_CLIENT_ID is configured, same gating pattern as
 * AniList's own env-driven config.
 *
 * Unlike AniList, MAL's authorization code grant requires PKCE (only the "plain"
 * challenge method is supported — challenge and verifier are the same string) and its
 * access tokens are short-lived (1 hour) with a real refresh grant (refresh token valid
 * 1 month); see myanimelist.net/apiconfig/references/authorization.
 */

const AUTHORIZE_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const API_BASE = 'https://api.myanimelist.net/v2';

function getClientId(): string {
  const id = process.env.MAL_CLIENT_ID;
  if (!id) throw new ServiceUnavailableError('MAL_CLIENT_ID is not configured');
  return id;
}

// MAL supports both confidential clients (with a secret) and public clients (PKCE only,
// no secret) — unlike AniList, where the secret is always required.
function getClientSecret(): string | undefined {
  return process.env.MAL_CLIENT_SECRET || undefined;
}

function getRedirectUri(): string {
  const uri = process.env.MAL_REDIRECT_URI;
  if (!uri) throw new ServiceUnavailableError('MAL_REDIRECT_URI is not configured');
  return uri;
}

function tokenRequestBody(fields: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams({ client_id: getClientId(), ...fields });
  const secret = getClientSecret();
  if (secret) {
    body.set('client_secret', secret);
  }
  return body;
}

async function postToken(
  body: URLSearchParams,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  try {
    const response = await requestWithRetry(() =>
      axios.post(TOKEN_URL, body, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    return response.data;
  } catch (error) {
    toTrackerError(error, 'MyAnimeList token');
  }
}

async function apiGet<T>(accessToken: string, path: string): Promise<T> {
  try {
    const response = await requestWithRetry(() =>
      axios.get<T>(`${API_BASE}${path}`, {
        timeout: 15000,
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    return response.data;
  } catch (error) {
    toTrackerError(error, 'MyAnimeList');
  }
}

async function apiPatch(
  accessToken: string,
  path: string,
  fields: Record<string, string>,
): Promise<void> {
  try {
    await requestWithRetry(() =>
      axios.patch(`${API_BASE}${path}`, new URLSearchParams(fields), {
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }),
    );
  } catch (error) {
    toTrackerError(error, 'MyAnimeList');
  }
}

const getAuthUrl = (state: string, codeVerifier: string): string => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: getClientId(),
    code_challenge: codeVerifier,
    code_challenge_method: 'plain',
    redirect_uri: getRedirectUri(),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
};

const exchangeCode = async (code: string, codeVerifier: string): Promise<TrackerTokens> => {
  const { access_token, refresh_token, expires_in } = await postToken(
    tokenRequestBody({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: getRedirectUri(),
    }),
  );

  const profile = await apiGet<{ id: number; name: string }>(
    access_token,
    '/users/@me?fields=name',
  );

  return {
    access_token,
    refresh_token: refresh_token ?? null,
    expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
    tracker_user_id: String(profile.id),
    tracker_username: profile.name,
  };
};

const refreshTokens = async (refreshToken: string): Promise<TrackerRefreshResult> => {
  const { access_token, refresh_token, expires_in } = await postToken(
    tokenRequestBody({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
  return {
    access_token,
    refresh_token: refresh_token ?? null,
    expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
  };
};

const searchMedia = async (
  accessToken: string,
  query: string,
): Promise<TrackerMediaSearchResult[]> => {
  const data = await apiGet<{
    data: { node: { id: number; title: string; main_picture?: { medium: string } } }[];
  }>(accessToken, `/manga?q=${encodeURIComponent(query)}&limit=10&fields=id,title,main_picture`);
  return data.data.map((entry) => ({
    tracker_media_id: String(entry.node.id),
    title: entry.node.title,
    cover_image_url: entry.node.main_picture?.medium ?? null,
  }));
};

const getProgress = async (
  accessToken: string,
  mediaId: string,
): Promise<TrackerProgress | null> => {
  const data = await apiGet<{
    my_list_status?: {
      status: string;
      num_chapters_read: number;
      score: number;
      updated_at: string;
    };
  }>(accessToken, `/manga/${encodeURIComponent(mediaId)}?fields=my_list_status`);

  const entry = data.my_list_status;
  if (!entry) {
    return null;
  }
  return {
    status: entry.status,
    progress: entry.num_chapters_read,
    // MAL's score is a plain 0-10 integer (no per-account format like AniList) —
    // normalized to this app's fixed 0-100 scale.
    score: entry.score > 0 ? Math.round((entry.score / 10) * 100) : null,
    updated_at: entry.updated_at ? new Date(entry.updated_at) : null,
  };
};

const updateProgress = async (
  accessToken: string,
  mediaId: string,
  progress: number,
): Promise<void> => {
  await apiPatch(accessToken, `/manga/${encodeURIComponent(mediaId)}/my_list_status`, {
    num_chapters_read: String(progress),
  });
};

const updateStatus = async (
  accessToken: string,
  mediaId: string,
  status: string,
): Promise<void> => {
  await apiPatch(accessToken, `/manga/${encodeURIComponent(mediaId)}/my_list_status`, { status });
};

const updateScore = async (accessToken: string, mediaId: string, score: number): Promise<void> => {
  const malScore = Math.round((score / 100) * 10);
  await apiPatch(accessToken, `/manga/${encodeURIComponent(mediaId)}/my_list_status`, {
    score: String(malScore),
  });
};

const TO_SHELF: Record<string, ShelfStatus | undefined> = {
  reading: 'READING',
  completed: 'COMPLETED',
  on_hold: 'ON_HOLD',
  dropped: 'DROPPED',
  plan_to_read: 'PLAN',
};
const FROM_SHELF: Record<ShelfStatus, string> = {
  READING: 'reading',
  COMPLETED: 'completed',
  ON_HOLD: 'on_hold',
  PLAN: 'plan_to_read',
  DROPPED: 'dropped',
};

const mapToShelfStatus = (nativeStatus: string): ShelfStatus | null =>
  TO_SHELF[nativeStatus] ?? null;
const mapFromShelfStatus = (shelf: ShelfStatus): string => FROM_SHELF[shelf];

const malTracker: TrackerAdapter = {
  getAuthUrl,
  exchangeCode,
  refreshTokens,
  searchMedia,
  getProgress,
  updateProgress,
  updateStatus,
  updateScore,
  mapToShelfStatus,
  mapFromShelfStatus,
};

export default malTracker;
