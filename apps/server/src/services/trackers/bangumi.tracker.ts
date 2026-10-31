import axios from 'axios';
import type { ShelfStatus } from '@projekt-manga/types';
import { ServiceUnavailableError, ValidationError } from '../../utils/customErrors.js';
import { requestWithRetry, statusOf, toTrackerError } from './httpRetry.js';
import type {
  TrackerAdapter,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerRefreshResult,
  TrackerTokens,
} from './tracker.interface.js';

/**
 * Bangumi (bgm.tv): OAuth2 authorization-code flow (no PKCE) with a refresh grant, same
 * shape as MyAnimeList. Needs an app registered at bgm.tv/dev/app
 * (BANGUMI_CLIENT_ID/SECRET/REDIRECT_URI). The v0 API asks every client to send a
 * descriptive User-Agent; BANGUMI_USER_AGENT overrides the default.
 *
 * Bangumi "subjects" of type 1 are books (manga included). A collection's `type` is the
 * reader's status: 1 wish, 2 done, 3 doing, 4 on hold, 5 dropped — the native status
 * string is that number. For books, `ep_status` is chapters read.
 */

const AUTHORIZE_URL = 'https://bgm.tv/oauth/authorize';
const TOKEN_URL = 'https://bgm.tv/oauth/access_token';
const API_BASE = 'https://api.bgm.tv/v0';
const SUBJECT_TYPE_BOOK = 1;
const COLLECTION_DOING = 3;

export interface BangumiSubject {
  id: number;
  name: string;
  name_cn?: string | null;
  images?: { small?: string | null; common?: string | null } | null;
}

export interface BangumiCollection {
  subject_id: number;
  type: number;
  rate: number;
  ep_status: number;
  updated_at: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ServiceUnavailableError(`${name} is not configured`);
  return value;
}

function userAgent(): string {
  return process.env.BANGUMI_USER_AGENT || 'ProjektManga/1.0 (self-hosted manga reader)';
}

async function postToken(fields: Record<string, string>) {
  try {
    const response = await requestWithRetry(() =>
      axios.post<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        user_id?: number;
      }>(
        TOKEN_URL,
        new URLSearchParams({
          client_id: requireEnv('BANGUMI_CLIENT_ID'),
          client_secret: requireEnv('BANGUMI_CLIENT_SECRET'),
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
    toTrackerError(error, 'Bangumi token');
  }
}

function requestConfig(accessToken: string) {
  return {
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': userAgent(),
      'Content-Type': 'application/json',
    },
  };
}

async function api<T>(
  method: 'get' | 'post',
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
        ...requestConfig(accessToken),
      }),
    );
    return response.data;
  } catch (error) {
    toTrackerError(error, 'Bangumi');
  }
}

const getMe = (accessToken: string) =>
  api<{ id: number; username: string; nickname?: string }>('get', accessToken, '/me');

function subjectId(mediaId: string): string {
  if (!/^\d+$/.test(mediaId)) throw new ValidationError('Invalid Bangumi subject id');
  return mediaId;
}

async function getCollection(
  accessToken: string,
  mediaId: string,
): Promise<BangumiCollection | null> {
  const me = await getMe(accessToken);
  const user = encodeURIComponent(me.username || String(me.id));
  try {
    const response = await requestWithRetry(() =>
      axios.request<BangumiCollection>({
        method: 'get',
        url: `${API_BASE}/users/${user}/collections/${subjectId(mediaId)}`,
        ...requestConfig(accessToken),
      }),
    );
    return response.data;
  } catch (error) {
    // 404 = not in this reader's collection.
    if (statusOf(error) === 404) return null;
    toTrackerError(error, 'Bangumi');
  }
}

/** POST on /users/-/collections/{id} both creates and modifies; a new collection
 * starts as "doing" unless the caller sets a type. */
async function saveCollection(
  accessToken: string,
  mediaId: string,
  fields: { type?: number; rate?: number; ep_status?: number },
): Promise<void> {
  const existing = await getCollection(accessToken, mediaId);
  const body = existing ? fields : { type: COLLECTION_DOING, ...fields };
  await api('post', accessToken, `/users/-/collections/${subjectId(mediaId)}`, body);
}

function expiresAt(expires_in: number | undefined): Date | null {
  return expires_in ? new Date(Date.now() + expires_in * 1000) : null;
}

// --- mapping (pure, unit-tested against recorded fixtures) ---

export function mapBangumiSearch(data: { data: BangumiSubject[] }): TrackerMediaSearchResult[] {
  return data.data.map((s) => ({
    tracker_media_id: String(s.id),
    title: s.name_cn || s.name,
    cover_image_url: s.images?.common || s.images?.small || null,
  }));
}

export function mapBangumiCollection(c: BangumiCollection | null): TrackerProgress | null {
  if (!c) return null;
  return {
    status: String(c.type),
    progress: c.ep_status ?? 0,
    // 0-10 integer, 0 = unrated.
    score: c.rate > 0 ? c.rate * 10 : null,
    updated_at: c.updated_at ? new Date(c.updated_at) : null,
  };
}

// --- adapter ---

const getAuthUrl = (state: string, _codeVerifier: string): string => {
  const params = new URLSearchParams({
    client_id: requireEnv('BANGUMI_CLIENT_ID'),
    redirect_uri: requireEnv('BANGUMI_REDIRECT_URI'),
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
};

const exchangeCode = async (code: string, _codeVerifier: string): Promise<TrackerTokens> => {
  const { access_token, refresh_token, expires_in } = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: requireEnv('BANGUMI_REDIRECT_URI'),
  });
  const me = await getMe(access_token);
  return {
    access_token,
    refresh_token: refresh_token ?? null,
    expires_at: expiresAt(expires_in),
    tracker_user_id: String(me.id),
    tracker_username: me.nickname || me.username || String(me.id),
  };
};

const refreshTokens = async (refreshToken: string): Promise<TrackerRefreshResult> => {
  const { access_token, refresh_token, expires_in } = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: requireEnv('BANGUMI_REDIRECT_URI'),
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
): Promise<TrackerMediaSearchResult[]> =>
  mapBangumiSearch(
    await api<{ data: BangumiSubject[] }>('post', accessToken, '/search/subjects?limit=10', {
      keyword: query,
      filter: { type: [SUBJECT_TYPE_BOOK] },
    }),
  );

const getProgress = async (accessToken: string, mediaId: string): Promise<TrackerProgress | null> =>
  mapBangumiCollection(await getCollection(accessToken, mediaId));

const TO_SHELF: Record<string, ShelfStatus | undefined> = {
  '1': 'PLAN',
  '2': 'COMPLETED',
  '3': 'READING',
  '4': 'ON_HOLD',
  '5': 'DROPPED',
};
const FROM_SHELF: Record<ShelfStatus, string> = {
  PLAN: '1',
  COMPLETED: '2',
  READING: '3',
  ON_HOLD: '4',
  DROPPED: '5',
};

const bangumiTracker: TrackerAdapter = {
  label: 'Bangumi',
  authKind: 'oauth',
  isConfigured: () =>
    !!process.env.BANGUMI_CLIENT_ID &&
    !!process.env.BANGUMI_CLIENT_SECRET &&
    !!process.env.BANGUMI_REDIRECT_URI,
  getAuthUrl,
  exchangeCode,
  refreshTokens,
  searchMedia,
  getProgress,
  updateProgress: (accessToken, mediaId, progress) =>
    saveCollection(accessToken, mediaId, { ep_status: progress }),
  updateStatus: async (accessToken, mediaId, status) => {
    const type = Number(status);
    if (!Number.isInteger(type)) return;
    await saveCollection(accessToken, mediaId, { type });
  },
  updateScore: (accessToken, mediaId, score) =>
    saveCollection(accessToken, mediaId, { rate: Math.round(score / 10) }),
  mapToShelfStatus: (nativeStatus) => TO_SHELF[nativeStatus] ?? null,
  mapFromShelfStatus: (shelf) => FROM_SHELF[shelf],
};

export default bangumiTracker;
