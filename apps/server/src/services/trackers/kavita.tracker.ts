import crypto from 'crypto';
import { ValidationError } from '../../utils/customErrors.js';
import {
  decodeServerCredential,
  encodeServerCredential,
  normalizeServerUrl,
  serverRequest,
  type ServerCredential,
  type ServerRequest,
} from './selfHosted.js';
import { SELF_HOSTED_FROM_SHELF, SELF_HOSTED_TO_SHELF } from './komga.tracker.js';
import type {
  TrackerAdapter,
  TrackerCredentials,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerTokens,
} from './tracker.interface.js';

/**
 * Kavita (self-hosted). The reader's API key (User settings → 3rd party clients) is
 * exchanged for a short-lived JWT via /api/Plugin/authenticate, against a reader-supplied
 * base URL guarded as described in selfHosted.ts. Only the URL and key are stored; JWTs
 * are cached in memory for a few minutes and re-issued as needed.
 *
 * Like Komga, Kavita has no list status or score: progress uses its "Tachiyomi" endpoints
 * (latest chapter read / mark read up to chapter N), status is derived from pages read,
 * and status/score pushes are no-ops.
 */

const LABEL = 'Kavita';
const PLUGIN_NAME = 'ProjektManga';
const JWT_TTL_MS = 10 * 60 * 1000;

export interface KavitaSearchResult {
  series: { seriesId: number; name: string; localizedName?: string | null }[];
}

export interface KavitaSeries {
  id: number;
  name: string;
  pages: number;
  pagesRead: number;
}

export interface KavitaChapter {
  minNumber?: number | null;
  number?: string | null;
}

// Keyed by a hash of the stored credential, never the credential itself.
const jwtCache = new Map<string, { token: string; expires_at: number }>();

async function authenticate(
  credential: ServerCredential,
  options: { credentials?: boolean } = {},
): Promise<{ token: string; username: string }> {
  return await serverRequest<{ token: string; username: string }>(
    credential.base_url,
    {
      method: 'post',
      path: '/api/Plugin/authenticate',
      params: { apiKey: credential.api_key, pluginName: PLUGIN_NAME },
    },
    LABEL,
    options,
  );
}

/** Keys the JWT cache, so the credential itself is never a lookup key in memory. Random per
 * process, since the key never leaves it. */
const JWT_CACHE_KEY_SECRET = crypto.randomBytes(32);

async function getJwt(credential: ServerCredential): Promise<string> {
  const key = crypto
    .createHmac('sha256', JWT_CACHE_KEY_SECRET)
    .update(encodeServerCredential(credential))
    .digest('base64url');
  const cached = jwtCache.get(key);
  if (cached && cached.expires_at > Date.now()) return cached.token;
  const { token } = await authenticate(credential);
  jwtCache.set(key, { token, expires_at: Date.now() + JWT_TTL_MS });
  return token;
}

async function call<T>(accessToken: string, request: ServerRequest): Promise<T> {
  const credential = decodeServerCredential(accessToken, LABEL);
  const jwt = await getJwt(credential);
  return serverRequest<T>(
    credential.base_url,
    { ...request, headers: { Authorization: `Bearer ${jwt}`, ...request.headers } },
    LABEL,
  );
}

function seriesId(mediaId: string): string {
  if (!/^\d{1,12}$/.test(mediaId)) throw new ValidationError('Invalid Kavita series id');
  return mediaId;
}

// --- mapping (pure, unit-tested against recorded fixtures) ---

export function mapKavitaSearch(data: KavitaSearchResult): TrackerMediaSearchResult[] {
  return (data.series ?? []).slice(0, 10).map((s) => ({
    tracker_media_id: String(s.seriesId),
    title: s.localizedName || s.name,
    // Covers need the API key in the URL, which must never reach the browser.
    cover_image_url: null,
  }));
}

export function kavitaStatus(series: KavitaSeries): string {
  if (series.pages > 0 && series.pagesRead >= series.pages) return 'READ';
  if (series.pagesRead > 0) return 'IN_PROGRESS';
  return 'UNREAD';
}

/** `latest` is null/empty when nothing has been read yet (Kavita answers 204). */
export function mapKavitaProgress(
  series: KavitaSeries,
  latest: KavitaChapter | null | '',
): TrackerProgress {
  const raw = latest ? (latest.minNumber ?? Number(latest.number)) : 0;
  return {
    status: kavitaStatus(series),
    progress: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0,
    score: null,
    updated_at: null,
  };
}

// --- adapter ---

const connectWithCredentials = async (credentials: TrackerCredentials): Promise<TrackerTokens> => {
  if (!credentials.base_url || !credentials.api_key) {
    throw new ValidationError('Kavita needs your server URL and an API key');
  }
  const base_url = await normalizeServerUrl(credentials.base_url, LABEL);
  const credential = { base_url, api_key: credentials.api_key };
  const user = await authenticate(credential, { credentials: true });
  return {
    access_token: encodeServerCredential(credential),
    refresh_token: null,
    expires_at: null,
    tracker_user_id: user.username,
    tracker_username: user.username,
  };
};

const searchMedia = async (
  accessToken: string,
  query: string,
): Promise<TrackerMediaSearchResult[]> =>
  mapKavitaSearch(
    await call<KavitaSearchResult>(accessToken, {
      method: 'get',
      path: '/api/Search/search',
      params: { queryString: query },
    }),
  );

const getProgress = async (accessToken: string, mediaId: string): Promise<TrackerProgress> => {
  const id = seriesId(mediaId);
  const series = await call<KavitaSeries>(accessToken, {
    method: 'get',
    path: `/api/Series/${id}`,
  });
  const latest = await call<KavitaChapter | ''>(accessToken, {
    method: 'get',
    path: '/api/Tachiyomi/latest-chapter',
    params: { seriesId: id },
  });
  return mapKavitaProgress(series, latest);
};

const updateProgress = async (accessToken: string, mediaId: string, progress: number) => {
  await call(accessToken, {
    method: 'post',
    path: '/api/Tachiyomi/mark-chapter-until-as-read',
    params: { seriesId: seriesId(mediaId), chapterNumber: progress },
  });
};

const kavitaTracker: TrackerAdapter = {
  label: LABEL,
  authKind: 'api_key',
  isConfigured: () => true,
  connectWithCredentials,
  searchMedia,
  getProgress,
  updateProgress,
  updateStatus: async () => {},
  updateScore: async () => {},
  mapToShelfStatus: (nativeStatus) => SELF_HOSTED_TO_SHELF[nativeStatus] ?? null,
  mapFromShelfStatus: (shelf) => SELF_HOSTED_FROM_SHELF[shelf],
};

export default kavitaTracker;
