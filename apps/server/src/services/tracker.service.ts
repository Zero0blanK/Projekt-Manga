import crypto from 'crypto';
import {
  isTrackerService,
  type ShelfStatus,
  type TrackerService as TrackerServiceEnum,
} from '@projekt-manga/types';
import trackerAccountRepository from '../repositories/trackerAccount.repository.js';
import trackerLinkRepository from '../repositories/trackerLink.repository.js';
import chapterRepository from '../repositories/chapter.repository.js';
import userChapterStateRepository from '../repositories/userChapterState.repository.js';
import userMangaStateRepository from '../repositories/userMangaState.repository.js';
import { getTrackerAdapter } from './trackers/index.js';
import type { TrackerAdapter, TrackerProgress } from './trackers/index.js';
import { encryptToken, decryptToken } from '../utils/tokenCrypto.js';
import { NotFoundError, RateLimitedError, UnauthorizedError } from '../utils/customErrors.js';

/**
 * Orchestrates the tracker-agnostic flow (OAuth, linking, progress/status/score
 * push/pull) on top of one of trackers/*'s per-service adapters.
 * Conflict resolution: progress is monotonic (only ever advances, in both push and pull directions);
 * status and score both follow last-write-wins anchored on whichever side's own
 * `updated_at` is newer (see applyRemoteEntryIfNewer).
 */

// In-memory, single-server OAuth CSRF state — short-lived (10 minutes, matching a
// realistic "click authorize, come back" window) and consumed exactly once. No
// database table for this: it's pure transient request-flow state, not something
// worth persisting across a restart (a restart mid-OAuth-flow just means the user
// retries, same as any other interrupted request). Also carries the PKCE code_verifier
// (MyAnimeList requires it; AniList ignores it) — generated for every tracker
// so the adapter interface needs no per-tracker flag.
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<
  string,
  { user_id: string; code_verifier: string; expires_at: number }
>();

function issueState(user_id: string): { state: string; code_verifier: string } {
  const state = crypto.randomBytes(24).toString('base64url');
  const code_verifier = crypto.randomBytes(48).toString('base64url'); // 64 chars, within PKCE's 43-128 range
  pendingStates.set(state, {
    user_id,
    code_verifier,
    expires_at: Date.now() + PENDING_STATE_TTL_MS,
  });
  return { state, code_verifier };
}

function consumeState(state: string, user_id: string): string | null {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expires_at < Date.now() || entry.user_id !== user_id) {
    return null;
  }
  return entry.code_verifier;
}

const getAuthUrl = (user_id: string, tracker: TrackerServiceEnum): string => {
  const adapter = getTrackerAdapter(tracker);
  const { state, code_verifier } = issueState(user_id);
  return adapter.getAuthUrl(state, code_verifier);
};

const handleCallback = async (
  user_id: string,
  tracker: TrackerServiceEnum,
  code: string,
  state: string,
) => {
  const code_verifier = consumeState(state, user_id);
  if (code_verifier === null) {
    throw new UnauthorizedError('Invalid or expired OAuth state');
  }
  const adapter = getTrackerAdapter(tracker);
  const tokens = await adapter.exchangeCode(code, code_verifier);

  return await trackerAccountRepository.upsert(user_id, tracker, {
    access_token: encryptToken(tokens.access_token),
    refresh_token: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
    expires_at: tokens.expires_at,
    tracker_user_id: tokens.tracker_user_id,
    tracker_username: tokens.tracker_username,
  });
};

const getConnectedTrackers = async (user_id: string) => {
  const accounts = await trackerAccountRepository.getAllForUser(user_id);
  // Never return access_token/refresh_token, encrypted or not — this is the one place
  // that reads the raw row, and it's deliberately stripped before leaving the service.
  return accounts.map((a) => ({
    tracker: a.tracker,
    tracker_username: a.tracker_username,
    connected_at: a.created_at,
  }));
};

const disconnect = async (user_id: string, tracker: TrackerServiceEnum) => {
  await trackerAccountRepository.deleteByUserAndTracker(user_id, tracker);
  await trackerLinkRepository.deleteAllForUserAndTracker(user_id, tracker);
};

type TrackerAccountRow = Awaited<ReturnType<typeof trackerAccountRepository.getByUserAndTracker>>;

// Dedupes concurrent refreshes for the same (user_id, tracker) — e.g. a chapter
// mark-read's pushProgressIfLinked firing at the same moment pollExternalChanges's
// interval does. Without this, both would read the same stored refresh_token and race
// to exchange it; MyAnimeList rotates refresh tokens on use, so the loser's exchange can
// fail with an "invalid_grant" that's really just unlucky timing, not a real fault. Kept
// as a plain in-memory map (not persisted) — same class of transient, single-server
// coordination as `pendingStates` above, and a restart mid-refresh just means the next
// call refreshes again.
const inFlightRefreshes = new Map<string, Promise<string>>();

/**
 * Returns a usable access token for this account, transparently refreshing it first if
 * it's expired and the tracker supports a refresh grant (MyAnimeList does; AniList
 * doesn't — its tokens are long-lived with no refresh mechanism at all, confirmed
 * against AniList's own docs). An expired token on a tracker with no refresh grant fails
 * closed with a clear "reconnect" error rather than attempting a call that would just
 * fail upstream with a less useful message.
 */
async function getValidAccessToken(
  user_id: string,
  tracker: TrackerServiceEnum,
  account: NonNullable<TrackerAccountRow>,
): Promise<string> {
  const adapter = getTrackerAdapter(tracker);
  const isExpired = account.expires_at != null && account.expires_at.getTime() <= Date.now();
  if (!isExpired) {
    return decryptToken(account.access_token);
  }

  if (!adapter.refreshTokens || !account.refresh_token) {
    throw new UnauthorizedError(
      `Your ${tracker} connection has expired — reconnect it in Settings.`,
    );
  }

  const key = `${user_id}:${tracker}`;
  const inFlight = inFlightRefreshes.get(key);
  if (inFlight) {
    return inFlight;
  }

  const refreshPromise = (async () => {
    const refreshed = await adapter.refreshTokens!(decryptToken(account.refresh_token!));
    await trackerAccountRepository.upsert(user_id, tracker, {
      access_token: encryptToken(refreshed.access_token),
      refresh_token: refreshed.refresh_token
        ? encryptToken(refreshed.refresh_token)
        : account.refresh_token,
      expires_at: refreshed.expires_at,
      tracker_user_id: account.tracker_user_id,
      tracker_username: account.tracker_username,
    });
    return refreshed.access_token;
  })();

  inFlightRefreshes.set(key, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightRefreshes.delete(key);
  }
}

const searchMedia = async (user_id: string, tracker: TrackerServiceEnum, query: string) => {
  const account = await trackerAccountRepository.getByUserAndTracker(user_id, tracker);
  if (!account) {
    throw new UnauthorizedError("This tracker isn't connected");
  }
  const adapter = getTrackerAdapter(tracker);
  const accessToken = await getValidAccessToken(user_id, tracker, account);
  return await adapter.searchMedia(accessToken, query);
};

/** The current furthest-read chapter number for this manga, computed fresh from
 * user_chapter_state rather than stored separately — stays correct when chapters are
 * read out of order and needs no extra column. Returns 0 if nothing's been read yet. */
async function computeLocalProgress(user_id: string, manga_id: string): Promise<number> {
  const chapters = await chapterRepository.getChapter(manga_id);
  if (chapters.length === 0) {
    return 0;
  }
  const states = await userChapterStateRepository.getForChapters(
    user_id,
    chapters.map((c) => c.id),
  );
  const readChapterIds = new Set(states.filter((s) => s.is_read).map((s) => s.chapter_id));
  const readNumbers = chapters.filter((c) => readChapterIds.has(c.id)).map((c) => c.chapter_number);
  return readNumbers.length > 0 ? Math.floor(Math.max(...readNumbers)) : 0;
}

/** Marks every chapter up to (and including) `progress` as read locally — never
 * unmarks anything, so this only ever advances local state, matching the monotonic
 * rule. Used on link (seeding from whatever's already on the tracker) and could be
 * reused by the polling job for a remote-side advance. */
async function applyRemoteProgressLocally(
  user_id: string,
  manga_id: string,
  progress: number,
): Promise<void> {
  if (progress <= 0) {
    return;
  }
  const chapters = await chapterRepository.getChapter(manga_id);
  const toMark = chapters.filter((c) => Math.floor(c.chapter_number) <= progress);
  // Two statements for the whole set rather than one upsert per chapter — seeding a
  // long-running series from a tracker meant hundreds of sequential round-trips.
  await userChapterStateRepository.markManyRead(
    user_id,
    toMark.map((c) => c.id),
  );
}

/**
 * Status and score have no "monotonic" direction the way progress does, so both follow
 * plain last-write-wins on the same anchor: whichever side's own timestamp is newer
 * wins, applied to both fields together since a tracker only exposes one `updated_at`
 * per list entry, not one per field. `remote.updated_at` is the tracker's own clock;
 * local is `user_manga_state.updated_at`. A tracker that doesn't expose a per-entry
 * timestamp (remote.updated_at === null) is skipped entirely rather than guessed at —
 * better to leave status/score alone than risk clobbering a local edit with no way to
 * tell which is newer. Returns whether it actually changed anything.
 */
async function applyRemoteEntryIfNewer(
  user_id: string,
  manga_id: string,
  tracker: TrackerServiceEnum,
  remote: TrackerProgress,
): Promise<boolean> {
  if (!remote.updated_at) {
    return false;
  }
  const local = await userMangaStateRepository.getEntry(user_id, manga_id);
  if (local && (local.edited_at ?? local.updated_at) >= remote.updated_at) {
    return false;
  }

  const adapter = getTrackerAdapter(tracker);
  const patch: { shelf_status?: ShelfStatus; score?: number } = {};
  const mappedStatus = adapter.mapToShelfStatus(remote.status);
  if (mappedStatus) {
    patch.shelf_status = mappedStatus;
  }
  if (remote.score !== null) {
    patch.score = remote.score;
  }
  if (Object.keys(patch).length === 0) {
    return false;
  }
  await userMangaStateRepository.upsert(user_id, manga_id, patch);
  return true;
}

const linkManga = async (
  user_id: string,
  manga_id: string,
  tracker: TrackerServiceEnum,
  tracker_media_id: string,
) => {
  const account = await trackerAccountRepository.getByUserAndTracker(user_id, tracker);
  if (!account) {
    throw new UnauthorizedError("This tracker isn't connected");
  }
  const adapter = getTrackerAdapter(tracker);
  const accessToken = await getValidAccessToken(user_id, tracker, account);

  const remote = await adapter.getProgress(accessToken, tracker_media_id);

  const link = await trackerLinkRepository.upsert(user_id, manga_id, tracker, {
    tracker_media_id,
    sync_enabled: true,
    last_synced_at: new Date(),
  });

  if (remote) {
    // Monotonic seed: bring local progress up to the tracker's count if it's ahead,
    // never pull it down if local is already further along.
    const local = await computeLocalProgress(user_id, manga_id);
    if (remote.progress > local) {
      await applyRemoteProgressLocally(user_id, manga_id, remote.progress);
    }
    await applyRemoteEntryIfNewer(user_id, manga_id, tracker, remote);
  }

  return link;
};

const getLinksForManga = async (user_id: string, manga_id: string) => {
  return await trackerLinkRepository.getForUserAndManga(user_id, manga_id);
};

const unlinkManga = async (user_id: string, manga_id: string, tracker: TrackerServiceEnum) => {
  const result = await trackerLinkRepository.deleteLink(user_id, manga_id, tracker);
  if (result.count === 0) {
    throw new NotFoundError('No tracker link found for this manga');
  }
};

/**
 * Links as the repository returns them, with `tracker` narrowed back to its union.
 *
 * Prisma types the column as `string` because SQLite has no enum. Narrowing here rather
 * than at each of the seven consumers keeps `getTrackerAdapter`/`getByUserAndTracker`
 * type-checked, and it is sound because every write goes through
 * tracker.controller.ts's `parseTracker`, which rejects anything outside the set.
 */
type RawEnabledLinks = Awaited<ReturnType<typeof trackerLinkRepository.getEnabledForUserAndManga>>;
type EnabledLinks = (Omit<RawEnabledLinks[number], 'tracker'> & {
  tracker: TrackerServiceEnum;
})[];

/**
 * Narrows repository rows to the `tracker` union, dropping anything unrecognised.
 *
 * A real filter, not a cast: SQLite stores the column as text, so a value written by an
 * older build or by hand could be outside the set. Such a link can never sync (there is
 * no adapter for it), so skipping it with a warning is better than letting it reach
 * `getTrackerAdapter` and throw mid-batch, taking the other links' cycle with it.
 */
function narrowLinks(rows: RawEnabledLinks): EnabledLinks {
  const out: EnabledLinks = [];
  for (const row of rows) {
    if (isTrackerService(row.tracker)) {
      out.push({ ...row, tracker: row.tracker });
    } else {
      console.warn(`[tracker] Link ${row.id} has unknown tracker "${row.tracker}" — skipping`);
    }
  }
  return out;
}

/** Shared by every pushXIfLinked below: resolves each link's account/adapter/token,
 * applies the caller's update, and touches last_synced_at — best-effort per link, so one
 * tracker being slow or down never blocks the others or fails the local write that
 * triggered this. */
async function pushToLinks(
  links: EnabledLinks,
  user_id: string,
  manga_id: string,
  label: string,
  apply: (adapter: TrackerAdapter, accessToken: string, tracker_media_id: string) => Promise<void>,
): Promise<void> {
  for (const link of links) {
    try {
      const account = await trackerAccountRepository.getByUserAndTracker(user_id, link.tracker);
      if (!account) {
        continue;
      }
      const adapter = getTrackerAdapter(link.tracker);
      const accessToken = await getValidAccessToken(user_id, link.tracker, account);
      await apply(adapter, accessToken, link.tracker_media_id);
      await trackerLinkRepository.touchSyncedAt(link.id);
    } catch (error) {
      console.error(
        `[tracker] Failed to push ${label} for manga ${manga_id} to ${link.tracker}:`,
        error,
      );
    }
  }
}

/** Called after a chapter is marked read (never on unread, since progress is monotonic). */
const pushProgressIfLinked = async (user_id: string, manga_id: string): Promise<void> => {
  const links = narrowLinks(
    await trackerLinkRepository.getEnabledForUserAndManga(user_id, manga_id),
  );
  if (links.length === 0) {
    return;
  }
  const progress = await computeLocalProgress(user_id, manga_id);
  await pushToLinks(links, user_id, manga_id, 'progress', (adapter, accessToken, mediaId) =>
    adapter.updateProgress(accessToken, mediaId, progress),
  );
};

/** Called whenever a signed-in reader changes a manga's shelf (see library.service.ts).
 * `shelf_status: null` ("no shelf") has no tracker-native equivalent, so it's simply not
 * pushed rather than guessed at. */
const pushStatusIfLinked = async (
  user_id: string,
  manga_id: string,
  shelf_status: ShelfStatus | null,
): Promise<void> => {
  if (shelf_status === null) {
    return;
  }
  const links = narrowLinks(
    await trackerLinkRepository.getEnabledForUserAndManga(user_id, manga_id),
  );
  if (links.length === 0) {
    return;
  }
  await pushToLinks(links, user_id, manga_id, 'status', (adapter, accessToken, mediaId) =>
    adapter.updateStatus(accessToken, mediaId, adapter.mapFromShelfStatus(shelf_status)),
  );
};

/** Called whenever a signed-in reader rates a manga (see library.service.ts). `score:
 * null` ("cleared rating") has no clean tracker-native equivalent to push either, so
 * it's skipped the same way as a null shelf_status. */
const pushScoreIfLinked = async (
  user_id: string,
  manga_id: string,
  score: number | null,
): Promise<void> => {
  if (score === null) {
    return;
  }
  const links = narrowLinks(
    await trackerLinkRepository.getEnabledForUserAndManga(user_id, manga_id),
  );
  if (links.length === 0) {
    return;
  }
  await pushToLinks(links, user_id, manga_id, 'score', (adapter, accessToken, mediaId) =>
    adapter.updateScore(accessToken, mediaId, score),
  );
};

/**
 * Reconciles one link in both directions, and reports whether anything changed.
 *
 * Progress is monotonic on both sides, so whichever side is further ahead wins: a remote
 * advance is applied locally, and a local advance is pushed up. That push half is what
 * makes the whole system self-healing — a push that failed at the time (tracker down,
 * rate-limited, app restarted mid-request) would otherwise be lost, because link-time
 * seeding only runs once. Status and score follow the same
 * last-write-wins rule as everywhere else (see applyRemoteEntryIfNewer).
 */
async function reconcileLink(link: EnabledLinks[number]): Promise<boolean> {
  const account = await trackerAccountRepository.getByUserAndTracker(link.user_id, link.tracker);
  if (!account) {
    // Shouldn't happen — disconnecting deletes a tracker's links along with it — but a
    // link with no account can never sync, and the cycle is ordered by last_synced_at
    // and capped. Left untouched it would sort first forever and burn a slot every cycle
    // while other links waited behind it, so it's rotated to the back instead.
    console.warn(`[tracker] Link ${link.id} has no ${link.tracker} account — skipping`);
    await trackerLinkRepository.touchSyncedAt(link.id);
    return false;
  }
  const adapter = getTrackerAdapter(link.tracker);
  const accessToken = await getValidAccessToken(link.user_id, link.tracker, account);
  const remote = await adapter.getProgress(accessToken, link.tracker_media_id);

  let changed = false;
  const local = await computeLocalProgress(link.user_id, link.manga_id);

  if (!remote) {
    // No list entry on the tracker's side yet — nothing to pull, but local progress
    // still belongs up there. This is the state right after linking media the reader
    // has never opened on the tracker itself.
    if (local > 0) {
      await adapter.updateProgress(accessToken, link.tracker_media_id, local);
      changed = true;
    }
    await trackerLinkRepository.touchSyncedAt(link.id);
    return changed;
  }

  if (remote.progress > local) {
    await applyRemoteProgressLocally(link.user_id, link.manga_id, remote.progress);
    changed = true;
  } else if (local > remote.progress) {
    await adapter.updateProgress(accessToken, link.tracker_media_id, local);
    changed = true;
  }

  if (await applyRemoteEntryIfNewer(link.user_id, link.manga_id, link.tracker, remote)) {
    changed = true;
  }

  await trackerLinkRepository.touchSyncedAt(link.id);
  return changed;
}

// One cycle's worth of links. Small on purpose: every link costs at least one upstream
// request and both trackers rate-limit per minute, so an unbounded cycle over a large
// library walks straight into 429s.
const DEFAULT_MAX_LINKS_PER_CYCLE = 20;

// Spacing between links inside a cycle. Deliberately not "as fast as the limit allows":
// this is a background job with a 30-minute budget and nothing waiting on it, so pacing
// it well under the limit leaves headroom for the foreground pushes a reader triggers by
// actually reading. Overridable mainly so the test suite can run a batch without waiting.
const DEFAULT_LINK_SPACING_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Oldest-synced-first, capped. This is the whole scheduling policy, and it buys more than
 * a bounded request count:
 *
 * - No link can starve, however large the library grows: syncing one moves it to the back
 *   of the queue, so every link is reached within a predictable number of cycles.
 * - Actively-read titles are skipped without needing any special case. Every push touches
 *   `last_synced_at` too, so a title being read right now is already the freshest entry in
 *   the list and sorts last on its own.
 *
 * A null `last_synced_at` (linked but never synced) sorts first — the one case where
 * nothing at all is known about the remote side yet.
 */
function selectLinksToPoll(links: EnabledLinks, limit: number): EnabledLinks {
  return [...links]
    .sort((a, b) => (a.last_synced_at?.getTime() ?? 0) - (b.last_synced_at?.getTime() ?? 0))
    .slice(0, limit);
}

/**
 * Walks a batch of links through reconcileLink, pacing the requests and giving up early
 * if a tracker rate-limits anyway — the adapter layer has already retried with the
 * tracker's own Retry-After by the time one of these surfaces, so continuing would only
 * queue up more of the same. Whatever's left keeps its old `last_synced_at` and therefore
 * sorts to the front of the next cycle.
 */
async function runSyncBatch(links: EnabledLinks): Promise<{ checked: number; updated: number }> {
  let checked = 0;
  let updated = 0;
  const spacing = linkSpacingMs();

  for (const link of links) {
    if (checked > 0 && spacing > 0) {
      await sleep(spacing);
    }
    checked += 1;
    try {
      if (await reconcileLink(link)) {
        updated += 1;
      }
    } catch (error) {
      if (error instanceof RateLimitedError) {
        console.warn(
          `[tracker] Rate limited on link ${link.id} — ending this cycle early: ${error.message}`,
        );
        break;
      }
      console.error(`[tracker] Sync failed for link ${link.id}:`, error);
    }
  }

  return { checked, updated };
}

function maxLinksPerCycle(): number {
  return Number(process.env.TRACKER_MAX_LINKS_PER_CYCLE) || DEFAULT_MAX_LINKS_PER_CYCLE;
}

function linkSpacingMs(): number {
  const configured = Number(process.env.TRACKER_LINK_SPACING_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_LINK_SPACING_MS;
}

/**
 * The background half of sync: catches progress/status/score changed on the tracker's own
 * site or app, and re-pushes local progress an earlier best-effort push failed to deliver.
 * Meant to be called on an interval (see initializeTrackerPolling); kept as a plain
 * function rather than scheduling itself so it stays directly testable.
 */
const pollExternalChanges = async (): Promise<{ checked: number; updated: number }> => {
  const links = narrowLinks(await trackerLinkRepository.getAllEnabled());
  return await runSyncBatch(selectLinksToPoll(links, maxLinksPerCycle()));
};

/**
 * The manual "Sync now" a reader can trigger from the UI, scoped to their own links. Same
 * reconcile as the background cycle, ordered and capped the same way so one impatient
 * click can't issue an unbounded burst of upstream requests.
 */
const syncNowForUser = async (user_id: string): Promise<{ checked: number; updated: number }> => {
  const links = narrowLinks(await trackerLinkRepository.getEnabledForUser(user_id));
  return await runSyncBatch(selectLinksToPoll(links, maxLinksPerCycle()));
};

const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** Starts the periodic external-change poll — a no-op if no tracker is configured at
 * all, so an install that never connects a tracker doesn't spend a timer on empty
 * queries every 30 minutes forever. `.unref()`'d so this timer alone never keeps the
 * process alive past a shutdown signal. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
function initializeTrackerPolling(): void {
  if (pollTimer) {
    return;
  }
  if (!process.env.ANILIST_CLIENT_ID && !process.env.MAL_CLIENT_ID) {
    return;
  }
  const intervalMs = Number(process.env.TRACKER_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
  // A cycle walks every link and calls an external API per link, so it has no fixed
  // duration — with enough links, a slow tracker or retries it can outlast the interval.
  // `setInterval` does not care, so without this a second cycle starts on top of the first,
  // and the two race to push progress for the same links against the same account.
  // `TRACKER_POLL_INTERVAL_MS` is tunable, which makes an interval shorter than a cycle a
  // configuration away rather than a theoretical concern.
  let pollInFlight = false;
  pollTimer = setInterval(() => {
    if (pollInFlight) {
      console.warn('[tracker] Previous poll cycle is still running — skipping this tick');
      return;
    }
    pollInFlight = true;
    pollExternalChanges()
      .then(({ checked, updated }) => {
        if (checked > 0) {
          console.log(`[tracker] Polled ${checked} link(s), ${updated} advanced`);
        }
      })
      .catch((error) => console.error('[tracker] Poll cycle failed:', error))
      // Cleared however the cycle ended, or one failure would wedge polling permanently.
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
  pollTimer.unref?.();
}

const trackerService = {
  getAuthUrl,
  handleCallback,
  getConnectedTrackers,
  disconnect,
  searchMedia,
  getLinksForManga,
  linkManga,
  unlinkManga,
  pushProgressIfLinked,
  pushStatusIfLinked,
  pushScoreIfLinked,
  pollExternalChanges,
  syncNowForUser,
  initializeTrackerPolling,
};

export default trackerService;
