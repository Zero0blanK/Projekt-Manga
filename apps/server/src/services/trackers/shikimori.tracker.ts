import axios from 'axios';
import type { ShelfStatus } from '@projekt-manga/types';
import { ServiceUnavailableError } from '../../utils/customErrors.js';
import { requestWithRetry, toTrackerError } from './httpRetry.js';
import type {
  TrackerAdapter,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerRefreshResult,
  TrackerTokens,
} from './tracker.interface.js';

/**
 * Shikimori: standard OAuth2 authorization-code flow (no PKCE) with short-lived access
 * tokens and a refresh grant — the same shape as MyAnimeList. Needs an app registered at
 * shikimori.one/oauth/applications (SHIKIMORI_CLIENT_ID/SECRET/REDIRECT_URI). Shikimori
 * also requires every request to carry a User-Agent naming that registered application;
 * SHIKIMORI_USER_AGENT overrides the default.
 *
 * List entries are "user rates"; finding one needs the reader's numeric user id, looked up
 * via /users/whoami.
 */

const BASE_URL = 'https://shikimori.one';
const AUTHORIZE_URL = `${BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${BASE_URL}/oauth/token`;

export interface ShikimoriManga {
  id: number;
  name: string;
  russian?: string | null;
  image?: { preview?: string | null; original?: string | null } | null;
}

export interface ShikimoriUserRate {
  id: number;
  status: string;
  chapters: number;
  score: number;
  updated_at: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ServiceUnavailableError(`${name} is not configured`);
  return value;
}

function userAgent(): string {
  return process.env.SHIKIMORI_USER_AGENT || 'ProjektManga';
}

async function postToken(fields: Record<string, string>) {
  try {
    const response = await requestWithRetry(() =>
      axios.post<{ access_token: string; refresh_token?: string; expires_in?: number }>(
        TOKEN_URL,
        new URLSearchParams({
          client_id: requireEnv('SHIKIMORI_CLIENT_ID'),
          client_secret: requireEnv('SHIKIMORI_CLIENT_SECRET'),
          ...fields,
        }),
        {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': userAgent(),
          },
        },
      ),
    );
    return response.data;
  } catch (error) {
    toTrackerError(error, 'Shikimori token');
  }
}

async function api<T>(
  method: 'get' | 'post' | 'patch',
  accessToken: string,
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    const response = await requestWithRetry(() =>
      axios.request<T>({
        method,
        url: `${BASE_URL}/api${path}`,
        data: body,
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': userAgent(),
          'Content-Type': 'application/json',
        },
      }),
    );
    return response.data;
  } catch (error) {
    toTrackerError(error, 'Shikimori');
  }
}

const whoami = (accessToken: string) =>
  api<{ id: number; nickname: string }>('get', accessToken, '/users/whoami');

async function findRate(
  accessToken: string,
  userId: number,
  mediaId: string,
): Promise<ShikimoriUserRate | null> {
  const params = new URLSearchParams({
    user_id: String(userId),
    target_id: mediaId,
    target_type: 'Manga',
  });
  const rates = await api<ShikimoriUserRate[]>(
    'get',
    accessToken,
    `/v2/user_rates?${params.toString()}`,
  );
  return rates[0] ?? null;
}

async function saveRate(
  accessToken: string,
  mediaId: string,
  fields: Partial<Pick<ShikimoriUserRate, 'status' | 'chapters' | 'score'>>,
): Promise<void> {
  const me = await whoami(accessToken);
  const existing = await findRate(accessToken, me.id, mediaId);
  if (existing) {
    await api('patch', accessToken, `/v2/user_rates/${existing.id}`, { user_rate: fields });
    return;
  }
  await api('post', accessToken, '/v2/user_rates', {
    user_rate: {
      user_id: me.id,
      target_id: Number(mediaId),
      target_type: 'Manga',
      status: 'watching',
      ...fields,
    },
  });
}

function expiresAt(expires_in: number | undefined): Date | null {
  return expires_in ? new Date(Date.now() + expires_in * 1000) : null;
}

// --- mapping (pure, unit-tested against recorded fixtures) ---

/** Image paths come back relative to the site root. */
function absoluteImage(path: string | null | undefined): string | null {
  if (!path || path.includes('missing_')) return null;
  return path.startsWith('http') ? path : `${BASE_URL}${path}`;
}

export function mapShikimoriSearch(data: ShikimoriManga[]): TrackerMediaSearchResult[] {
  return data.map((m) => ({
    tracker_media_id: String(m.id),
    title: m.name || m.russian || String(m.id),
    cover_image_url: absoluteImage(m.image?.preview ?? m.image?.original),
  }));
}

export function mapShikimoriRate(rate: ShikimoriUserRate | null): TrackerProgress | null {
  if (!rate) return null;
  return {
    status: rate.status,
    progress: rate.chapters ?? 0,
    // Plain 0-10 integer, 0 = unscored.
    score: rate.score > 0 ? rate.score * 10 : null,
    updated_at: rate.updated_at ? new Date(rate.updated_at) : null,
  };
}

// --- adapter ---

const getAuthUrl = (state: string, _codeVerifier: string): string => {
  const params = new URLSearchParams({
    client_id: requireEnv('SHIKIMORI_CLIENT_ID'),
    redirect_uri: requireEnv('SHIKIMORI_REDIRECT_URI'),
    response_type: 'code',
    scope: 'user_rates',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
};

const exchangeCode = async (code: string, _codeVerifier: string): Promise<TrackerTokens> => {
  const { access_token, refresh_token, expires_in } = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: requireEnv('SHIKIMORI_REDIRECT_URI'),
  });
  const me = await whoami(access_token);
  return {
    access_token,
    refresh_token: refresh_token ?? null,
    expires_at: expiresAt(expires_in),
    tracker_user_id: String(me.id),
    tracker_username: me.nickname,
  };
};

const refreshTokens = async (refreshToken: string): Promise<TrackerRefreshResult> => {
  const { access_token, refresh_token, expires_in } = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
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
  const params = new URLSearchParams({ search: query, limit: '10' });
  return mapShikimoriSearch(
    await api<ShikimoriManga[]>('get', accessToken, `/mangas?${params.toString()}`),
  );
};

const getProgress = async (
  accessToken: string,
  mediaId: string,
): Promise<TrackerProgress | null> => {
  const me = await whoami(accessToken);
  return mapShikimoriRate(await findRate(accessToken, me.id, mediaId));
};

// Shikimori's manga rates reuse the anime vocabulary ("watching" = reading).
const TO_SHELF: Record<string, ShelfStatus | undefined> = {
  watching: 'READING',
  rewatching: 'READING',
  planned: 'PLAN',
  completed: 'COMPLETED',
  on_hold: 'ON_HOLD',
  dropped: 'DROPPED',
};
const FROM_SHELF: Record<ShelfStatus, string> = {
  READING: 'watching',
  COMPLETED: 'completed',
  ON_HOLD: 'on_hold',
  PLAN: 'planned',
  DROPPED: 'dropped',
};

const shikimoriTracker: TrackerAdapter = {
  label: 'Shikimori',
  authKind: 'oauth',
  isConfigured: () =>
    !!process.env.SHIKIMORI_CLIENT_ID &&
    !!process.env.SHIKIMORI_CLIENT_SECRET &&
    !!process.env.SHIKIMORI_REDIRECT_URI,
  getAuthUrl,
  exchangeCode,
  refreshTokens,
  searchMedia,
  getProgress,
  updateProgress: (accessToken, mediaId, progress) =>
    saveRate(accessToken, mediaId, { chapters: progress }),
  updateStatus: (accessToken, mediaId, status) => saveRate(accessToken, mediaId, { status }),
  updateScore: (accessToken, mediaId, score) =>
    saveRate(accessToken, mediaId, { score: Math.round(score / 10) }),
  mapToShelfStatus: (nativeStatus) => TO_SHELF[nativeStatus] ?? null,
  mapFromShelfStatus: (shelf) => FROM_SHELF[shelf],
};

export default shikimoriTracker;
