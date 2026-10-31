import type { ShelfStatus } from '@projekt-manga/types';
import { ValidationError } from '../../utils/customErrors.js';
import {
  decodeServerCredential,
  encodeServerCredential,
  normalizeServerUrl,
  serverRequest,
  type ServerRequest,
} from './selfHosted.js';
import type {
  TrackerAdapter,
  TrackerCredentials,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerTokens,
} from './tracker.interface.js';

/**
 * Komga (self-hosted). Authenticates with an API key (Komga 1.13+, `X-API-Key` header)
 * against a reader-supplied base URL — see selfHosted.ts for how that URL is guarded.
 *
 * Komga isn't a list tracker: there's no status or score to sync. Its "tachiyomi"
 * read-progress endpoints report and set progress by book number, which is what this
 * adapter maps onto chapter progress. Status is derived from read counts (UNREAD /
 * IN_PROGRESS / READ) and has no `updated_at`, so it is never pulled; status and score
 * pushes are no-ops.
 */

const LABEL = 'Komga';

export interface KomgaSeries {
  id: string;
  name: string;
  metadata?: { title?: string | null } | null;
}

export interface KomgaReadProgress {
  booksCount: number;
  booksReadCount: number;
  booksUnreadCount: number;
  booksInProgressCount: number;
  lastReadContinuousNumberSort: number;
  maxNumberSort: number;
}

function seriesId(mediaId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) throw new ValidationError('Invalid Komga series id');
  return mediaId;
}

function call<T>(accessToken: string, request: ServerRequest): Promise<T> {
  const { base_url, api_key } = decodeServerCredential(accessToken, LABEL);
  return serverRequest<T>(
    base_url,
    { ...request, headers: { 'X-API-Key': api_key, ...request.headers } },
    LABEL,
  );
}

// --- mapping (pure, unit-tested against recorded fixtures) ---

export function mapKomgaSearch(data: { content: KomgaSeries[] }): TrackerMediaSearchResult[] {
  return data.content.map((s) => ({
    tracker_media_id: s.id,
    title: s.metadata?.title || s.name,
    // Thumbnails need the API key, which must never reach the browser.
    cover_image_url: null,
  }));
}

export function komgaStatus(p: KomgaReadProgress): string {
  if (p.booksCount > 0 && p.booksReadCount >= p.booksCount) return 'READ';
  if (p.booksReadCount > 0 || p.booksInProgressCount > 0) return 'IN_PROGRESS';
  return 'UNREAD';
}

export function mapKomgaProgress(p: KomgaReadProgress): TrackerProgress {
  return {
    status: komgaStatus(p),
    progress: Math.max(0, Math.floor(p.lastReadContinuousNumberSort ?? 0)),
    score: null,
    updated_at: null,
  };
}

// --- adapter ---

const connectWithCredentials = async (credentials: TrackerCredentials): Promise<TrackerTokens> => {
  if (!credentials.base_url || !credentials.api_key) {
    throw new ValidationError('Komga needs your server URL and an API key');
  }
  const base_url = await normalizeServerUrl(credentials.base_url, LABEL);
  const me = await serverRequest<{ id: string; email: string }>(
    base_url,
    { method: 'get', path: '/api/v2/users/me', headers: { 'X-API-Key': credentials.api_key } },
    LABEL,
    { credentials: true },
  );
  return {
    access_token: encodeServerCredential({ base_url, api_key: credentials.api_key }),
    refresh_token: null,
    expires_at: null,
    tracker_user_id: me.id,
    tracker_username: me.email,
  };
};

const searchMedia = async (
  accessToken: string,
  query: string,
): Promise<TrackerMediaSearchResult[]> =>
  mapKomgaSearch(
    await call<{ content: KomgaSeries[] }>(accessToken, {
      method: 'get',
      path: '/api/v1/series',
      params: { search: query, size: 10 },
    }),
  );

const getProgress = async (accessToken: string, mediaId: string): Promise<TrackerProgress> =>
  mapKomgaProgress(
    await call<KomgaReadProgress>(accessToken, {
      method: 'get',
      path: `/api/v2/series/${seriesId(mediaId)}/read-progress/tachiyomi`,
    }),
  );

const updateProgress = async (accessToken: string, mediaId: string, progress: number) => {
  await call(accessToken, {
    method: 'put',
    path: `/api/v2/series/${seriesId(mediaId)}/read-progress/tachiyomi`,
    headers: { 'Content-Type': 'application/json' },
    data: { lastBookNumberSortRead: progress },
  });
};

export const SELF_HOSTED_TO_SHELF: Record<string, ShelfStatus | undefined> = {
  UNREAD: 'PLAN',
  IN_PROGRESS: 'READING',
  READ: 'COMPLETED',
};
export const SELF_HOSTED_FROM_SHELF: Record<ShelfStatus, string> = {
  PLAN: 'UNREAD',
  READING: 'IN_PROGRESS',
  ON_HOLD: 'IN_PROGRESS',
  DROPPED: 'IN_PROGRESS',
  COMPLETED: 'READ',
};

const komgaTracker: TrackerAdapter = {
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

export default komgaTracker;
