import axios from 'axios';
import type { ShelfStatus } from '@projekt-manga/types';
import { ServiceUnavailableError, UpstreamError } from '../../utils/customErrors.js';
import { requestWithRetry, toTrackerError } from './httpRetry.js';
import type {
  TrackerAdapter,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerTokens,
} from './tracker.interface.js';

const AUTHORIZE_URL = 'https://anilist.co/api/v2/oauth/authorize';
const TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';
const GRAPHQL_URL = 'https://graphql.anilist.co';

function getClientId(): string {
  const id = process.env.ANILIST_CLIENT_ID;
  if (!id) throw new ServiceUnavailableError('ANILIST_CLIENT_ID is not configured');
  return id;
}

function getClientSecret(): string {
  const secret = process.env.ANILIST_CLIENT_SECRET;
  if (!secret) throw new ServiceUnavailableError('ANILIST_CLIENT_SECRET is not configured');
  return secret;
}

function getRedirectUri(): string {
  const uri = process.env.ANILIST_REDIRECT_URI;
  if (!uri) throw new ServiceUnavailableError('ANILIST_REDIRECT_URI is not configured');
  return uri;
}

interface GraphQLResponse<T> {
  data: T;
  errors?: { message: string }[];
}

async function graphqlRequest<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let response;
  try {
    response = await requestWithRetry(() =>
      axios.post<GraphQLResponse<T>>(
        GRAPHQL_URL,
        { query, variables },
        {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        },
      ),
    );
  } catch (error) {
    toTrackerError(error, 'AniList');
  }

  if (response.data.errors?.length) {
    throw new UpstreamError(
      `AniList API error: ${response.data.errors.map((e) => e.message).join(', ')}`,
    );
  }
  return response.data.data;
}

// AniList access tokens are long-lived (1 year) and the API has no refresh grant (see
// docs.anilist.co/guide/auth). No `refreshTokens` export here; tracker.service.ts treats an
// expired AniList token as "reconnect required".
// No PKCE either — `codeVerifier` below is accepted (interface uniformity) and ignored.

const getAuthUrl = (state: string, _codeVerifier: string): string => {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
};

const exchangeCode = async (code: string, _codeVerifier: string): Promise<TrackerTokens> => {
  let tokenResponse;
  try {
    tokenResponse = await requestWithRetry(() =>
      axios.post(
        TOKEN_URL,
        {
          grant_type: 'authorization_code',
          client_id: getClientId(),
          client_secret: getClientSecret(),
          redirect_uri: getRedirectUri(),
          code,
        },
        {
          timeout: 15000,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        },
      ),
    );
  } catch (error) {
    toTrackerError(error, 'AniList token exchange');
  }

  const { access_token, refresh_token, expires_in } = tokenResponse.data as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const viewer = await graphqlRequest<{ Viewer: { id: number; name: string } }>(
    access_token,
    `query { Viewer { id name } }`,
    {},
  );

  return {
    access_token,
    refresh_token: refresh_token ?? null,
    expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
    tracker_user_id: String(viewer.Viewer.id),
    tracker_username: viewer.Viewer.name,
  };
};

const searchMedia = async (
  accessToken: string,
  query: string,
): Promise<TrackerMediaSearchResult[]> => {
  const data = await graphqlRequest<{
    Page: {
      media: {
        id: number;
        title: { romaji: string; english: string | null };
        coverImage: { medium: string | null };
      }[];
    };
  }>(
    accessToken,
    `query ($search: String) {
      Page(perPage: 10) {
        media(search: $search, type: MANGA) {
          id
          title { romaji english }
          coverImage { medium }
        }
      }
    }`,
    { search: query },
  );

  return data.Page.media.map((m) => ({
    tracker_media_id: String(m.id),
    title: m.title.english || m.title.romaji,
    cover_image_url: m.coverImage?.medium ?? null,
  }));
};

const getProgress = async (
  accessToken: string,
  mediaId: string,
): Promise<TrackerProgress | null> => {
  const data = await graphqlRequest<{
    Media: {
      mediaListEntry: {
        status: string;
        progress: number;
        scoreRaw: number;
        updatedAt: number | null;
      } | null;
    };
  }>(
    accessToken,
    `query ($id: Int) {
      Media(id: $id, type: MANGA) {
        mediaListEntry { status progress scoreRaw updatedAt }
      }
    }`,
    { id: Number(mediaId) },
  );

  const entry = data.Media.mediaListEntry;
  if (!entry) {
    return null;
  }
  return {
    status: entry.status,
    progress: entry.progress,
    // scoreRaw is always the 0-100 point scale regardless of the account's own display
    // format (POINT_10, POINT_5, ...) — no per-account format lookup/conversion needed.
    score: entry.scoreRaw > 0 ? entry.scoreRaw : null,
    // AniList's updatedAt is unix seconds, not milliseconds.
    updated_at: entry.updatedAt ? new Date(entry.updatedAt * 1000) : null,
  };
};

const updateProgress = async (
  accessToken: string,
  mediaId: string,
  progress: number,
): Promise<void> => {
  await graphqlRequest(
    accessToken,
    `mutation ($mediaId: Int, $progress: Int) {
      SaveMediaListEntry(mediaId: $mediaId, progress: $progress) { id }
    }`,
    { mediaId: Number(mediaId), progress },
  );
};

const updateStatus = async (
  accessToken: string,
  mediaId: string,
  status: string,
): Promise<void> => {
  await graphqlRequest(
    accessToken,
    `mutation ($mediaId: Int, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, status: $status) { id }
    }`,
    { mediaId: Number(mediaId), status },
  );
};

const updateScore = async (accessToken: string, mediaId: string, score: number): Promise<void> => {
  await graphqlRequest(
    accessToken,
    `mutation ($mediaId: Int, $scoreRaw: Int) {
      SaveMediaListEntry(mediaId: $mediaId, scoreRaw: $scoreRaw) { id }
    }`,
    { mediaId: Number(mediaId), scoreRaw: score },
  );
};

// AniList's own status vocabulary (MediaListStatus) vs this app's ShelfStatus — REPEATING
// has no local equivalent, mapped to READING (closer than dropping the info entirely).
const TO_SHELF: Record<string, ShelfStatus | undefined> = {
  CURRENT: 'READING',
  REPEATING: 'READING',
  PLANNING: 'PLAN',
  COMPLETED: 'COMPLETED',
  DROPPED: 'DROPPED',
  PAUSED: 'ON_HOLD',
};
const FROM_SHELF: Record<ShelfStatus, string> = {
  READING: 'CURRENT',
  COMPLETED: 'COMPLETED',
  ON_HOLD: 'PAUSED',
  PLAN: 'PLANNING',
  DROPPED: 'DROPPED',
};

const mapToShelfStatus = (nativeStatus: string): ShelfStatus | null =>
  TO_SHELF[nativeStatus] ?? null;
const mapFromShelfStatus = (shelf: ShelfStatus): string => FROM_SHELF[shelf];

const anilistTracker: TrackerAdapter = {
  getAuthUrl,
  exchangeCode,
  searchMedia,
  getProgress,
  updateProgress,
  updateStatus,
  updateScore,
  mapToShelfStatus,
  mapFromShelfStatus,
};

export default anilistTracker;
