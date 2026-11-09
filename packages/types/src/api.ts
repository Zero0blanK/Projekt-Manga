/**
 * What the API answers with: the shapes `packages/api-client` returns and the renderer and
 * desktop app read. Here rather than in the client so anything on either side of the API can
 * name them without depending on how a request is made.
 */
import type {
  DevicePlatform,
  NotificationChannelKind,
  ShelfStatus,
  TrackerService,
  TranslateProvider,
  UpdateLogKind,
} from './enums.js';
import type { Chapters } from './extension.js';

// ── auth ─────────────────────────────────────────────────────────────────────

export interface PublicUser {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

export interface RegisterPayload {
  email: string;
  password: string;
  display_name?: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

// ── cache ────────────────────────────────────────────────────────────────────

export interface CacheSyncResult {
  updated: boolean;
  hostedUrl?: string;
}

export interface CacheStatus {
  exists: boolean;
  manga_id: string;
  thumbnail_url: string;
  sha256_url: string;
}

// ── category ─────────────────────────────────────────────────────────────────

export interface Category {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** One of the caller's categories with the titles in it. */
export interface CategoryWithMembers {
  id: string;
  name: string;
  manga_ids: string[];
}

// ── chapter ──────────────────────────────────────────────────────────────────

/** Chapter payloads name a chapter the way its source does: `id` is the source's key (a
 * stored record's `source_chapter_key`), never a stored row id. */
export type ChapterBulkPayload = Partial<Chapters> & { source?: string };

export type ChapterProgressMeta = Partial<Chapters> & { source: string };

export interface UpdateResult {
  count: number;
}

export interface BulkMarkResult {
  count: number;
  failed_source_chapter_keys: string[];
}

export interface ChapterProgress {
  last_page_read: number;
  is_read: boolean;
}

export interface ChapterReadStatus {
  is_read: boolean;
}

export interface RecentChapter extends MangaChapterRecord {
  manga: {
    id: string;
    slug: string;
    title: string;
    thumbnail_url: string;
  };
}

/** Manga-level fields recorded on the history rows a bulk mark writes. Only needed for
 * titles that have no library row to join a title/cover from. */
export interface BulkMarkMangaMeta {
  /** Used by desktop's local chapter/history rows; ignored by the server schema. */
  manga_id?: string;
  source_manga_id?: string;
  title?: string;
  thumbnail_url?: string;
}

// ── download ─────────────────────────────────────────────────────────────────

export interface InitiateDownloadChapter {
  /** The source's own id for the chapter (a stored record's `source_chapter_key`). */
  id: string;
  name?: string;
  chapter_number: number;
}

export interface InitiateDownloadInput {
  sourceId: string;
  mangaSlug: string;
  mangaTitle: string;
  chapter: InitiateDownloadChapter;
  downloadPath?: string;
}

export interface InitiateDownloadResult {
  id: string;
  status: string;
  progress: number;
  message: string;
}

export interface DownloadStatusResponse {
  id: string;
  status: string;
  mangaTitle: string;
  chapterTitle: string;
  filePath: string;
  completedAt: string | null;
}

export interface DownloadSummary {
  id: string;
  manga_id: string;
  chapter_id: string;
  /** The source's own id for the chapter, for matching against a source listing. */
  source_chapter_key: string;
  source_id: string;
  mangaSlug: string;
  status: string;
  mangaTitle: string;
  chapterTitle: string;
  chapterNumber: number;
  pages_total: number;
  pages_downloaded: number;
  current_page: number;
  filePath: string;
  downloaded_path: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DownloadStats {
  total: number;
  completed: number;
  inProgress: number;
  failed: number;
  totalSize: number;
  storageLimit: number;
  freeBytes: number | null;
}

export interface OrphanedDownloadFolder {
  id: string;
  title: string;
  chapterFolder: string;
  pageCount: number;
  sizeBytes: number;
  modifiedAt: string;
}

/**
 * A title folder of downloads the app has no record of — left by an earlier install whose
 * app data is gone, or kept in a folder this install never used.
 *
 * - `ready`: its chapters can be restored now.
 * - `needs-source`: made before downloads recorded their identity, and its source isn't
 *   installed, so its chapters can't be matched yet. Installing the source fixes it.
 * - `not-found`: the source is installed but no title on it matches the folder.
 * - `lookup-failed`: the source didn't answer; trying again later may work.
 * - `nothing-to-restore`: every chapter is already in the app or incomplete.
 */
export type RestorableTitleStatus =
  'ready' | 'needs-source' | 'not-found' | 'lookup-failed' | 'nothing-to-restore';

export interface RestorableTitle {
  /** Stable across scans of the same folder; what a restore request names. */
  id: string;
  source: string;
  /** The source's display name, when it is installed. */
  sourceName: string | null;
  title: string;
  thumbnailUrl: string | null;
  /** The title's folder on disk. */
  folder: string;
  status: RestorableTitleStatus;
  chapters: {
    /** Complete and identified: these come back. */
    ready: number;
    /** Missing pages; left alone. */
    incomplete: number;
    /** That chapter is already downloaded elsewhere in the app. */
    alreadyInApp: number;
    /** Made before downloads recorded their identity and not found on the source. */
    unmatched: number;
  };
  sizeBytes: number;
}

export interface DownloadRestoreScan {
  /** The folders that were looked through. */
  roots: string[];
  titles: RestorableTitle[];
  /** Chapters across all titles that a restore would bring back. */
  restorableChapters: number;
}

export interface DownloadRestoreResult {
  /** Chapters added back. */
  restored: number;
  /** Chapters the app knew about but had lost track of, now pointed at the files found. */
  relinked: number;
  /** The titles restored, with the app's id for each, so they can be added to the library. */
  titles: { id: string; mangaId: string; title: string }[];
}

export interface DownloadedPage {
  index: number;
  retryable: boolean;
}

export interface DownloadWorkerStatus {
  queueLength: number;
  activeDownloads: number;
  pausedDownloads: number;
  maxConcurrent: number;
  threadCount: number;
}

export interface DownloadProgressEvent {
  downloadId: string;
  currentPage: number;
  totalPages: number;
  pagesDownloaded: number;
}

// ── extensionRepository ──────────────────────────────────────────────────────

export interface ExtensionRepository {
  id: string;
  url: string;
  /** From the repository's own `repository` block; null when it publishes none, in which
   * case the UI shows the URL instead. */
  name: string | null;
  badge_label: string | null;
  description: string | null;
  website: string | null;
  added_at: string;
  last_fetched_at: string | null;
  enabled: boolean;
}

export interface InstalledExtension {
  id: string;
  repository_id: string;
  source_key: string;
  name: string;
  lang: string;
  base_url: string;
  is_nsfw: boolean;
  /** `safe` | `mixed` | `nsfw`, captured at install time. Null for a row installed before
   * it was recorded — `is_nsfw` is the fallback, and cannot distinguish mixed from safe. */
  content_rating: string | null;
  allowed_hosts: string[];
  version: string;
  api_version: number;
  version_code: number | null;
  entry_url: string;
  description: string | null;
  homepage: string | null;
  icon_url: string | null;
  source_code_hash: string;
  installed_at: string;
  updated_at: string;
  enabled: boolean;
}

// ── health ───────────────────────────────────────────────────────────────────

export interface HealthStatus {
  status: string;
  timestamp: string;
  endpoints: string[];
}

/**
 * Shape of GET /api/health/scraper. Only the fields a caller actually reads are declared —
 * the endpoint returns more (per-proxy detail, circuit-breaker internals, the full recent
 * ban list), and pulling all of it into a shared type would invite it into places that
 * shouldn't show it. `recentBans` entries are intentionally left opaque: the diagnostic
 * report counts them rather than printing per-title URLs.
 */
export interface ScraperHealth {
  available?: boolean;
  reason?: string;
  enabled: boolean;
  proxy: {
    totalProxies: number;
    healthyProxies: number;
    coolingDownProxies: number;
  };
  htmlCache: {
    hits: number;
    misses: number;
  };
  recentBans: unknown[];
  userAgent: {
    usingRemoteProfile: boolean;
    profileCount: number;
  };
  circuitBreakers?: Array<{
    source: string;
    consecutiveFailures: number;
    isOpen: boolean;
    openRemainingMs: number;
  }>;
}

export interface ServerDiagnosticEvent {
  at: string;
  level: 'info' | 'warn' | 'error';
  area: 'api' | 'download' | 'restore' | 'sync';
  event: string;
  requestId: string | null;
  jobId: string | null;
  code: string | null;
  counts: Record<string, number>;
}

/** Shape of GET /api/health/runtime (admin only). Counts are null when a table could not
 * be read. */
export interface ServerRuntimeDiagnostics {
  node: string;
  platform: string;
  nodeEnv: string | null;
  uptimeSeconds: number;
  memoryMb: { rss: number; heapUsed: number; heapTotal: number };
  features: {
    adminToken: boolean;
    tokenEncryptionKey: boolean;
    clientUrl: boolean;
    trustProxy: boolean;
    translate: string | null;
  };
  migrations: { applied: number; latest: string | null; failed: number } | null;
  counts: Record<string, number | null>;
  downloads: Record<string, number> | null;
}

// ── history ──────────────────────────────────────────────────────────────────

/** Row shape returned by GET /history (flattened, with manga title/thumbnail resolved). */
export interface HistoryEntry {
  id: string;
  source: string;
  manga_id?: string;
  /** Whether this title is in the current account's library (or the anonymous library). */
  in_library?: boolean;
  manga_slug: string;
  source_manga_id?: string;
  /** The stored chapter's own id, for library reader links. */
  chapter_id?: string;
  /** The source's id for the chapter, for source (preview) reader links. */
  source_chapter_key?: string;
  pages_read: number;
  time_read: number;
  last_read: string;
  read_at: string;
  title?: string;
  thumbnail_url?: string;
  chapter_number?: number;
  name?: string;
  is_read?: boolean;
  last_page_read: number;
  page_count: number;
}

export interface HistoryRecord {
  id: string;
  source: string;
  manga_id: string | null;
  manga_slug: string;
  source_manga_id?: string | null;
  chapter_id: string | null;
  thumbnail_url: string | null;
  read_at: string;
  last_read: string;
  pages_read: number;
  time_read: number;
}

export interface HistoryByMangaSlugEntry extends HistoryRecord {
  chapter: {
    id: string;
    source_chapter_key: string;
    chapter_number: number;
    name: string | null;
    is_read: boolean;
    last_page_read: number;
    page_count: number | null;
  } | null;
}

// ── library ──────────────────────────────────────────────────────────────────

export interface LibraryState {
  manga_id: string;
  is_bookmarked: boolean;
  shelf_status: ShelfStatus | null;
  /** Personal rating, 0-100. Absent entirely on the anonymous (no-account) path — the
   * shared manga_library table has no such column, since a rating only makes sense
   * per-account. */
  score?: number | null;
  notification_read: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpdateLibraryStatePayload {
  is_bookmarked?: boolean;
  shelf_status?: ShelfStatus | null;
  score?: number | null;
  notification_read?: boolean;
}

/** When a library title's next chapter is expected, from its recent release cadence. */
export interface ReleaseEstimate {
  manga_id: string;
  interval_days: number;
  next_expected_at: string;
  last_chapter_at: string;
}

// ── manga ────────────────────────────────────────────────────────────────────

export interface Manga {
  id: string;
  /** False for rows that exist only to back a source preview/download. */
  in_library: boolean;
  slug: string;
  title: string;
  author: string;
  source: string;
  thumbnail_url: string;
  /** Present on server responses when a private cover has been cached. */
  cache?: { sha256_url: string } | null;
  /** This reader's own edits, already applied to the fields above; null when there are
   * none. Absent on responses that do not merge edits (desktop's local database). */
  override?: MangaOverride | null;
  created_at: string;
  updated_at: string;
}

/** A reader's local edit to a title. A null field shows the source's value. */
export interface MangaOverride {
  title: string | null;
  author: string | null;
  description: string | null;
  status: string | null;
  /** A custom cover replaces the source's at /cache/thumbnail/:id. */
  has_cover: boolean;
  updated_at: string;
  /** The catalog values underneath the edits. */
  original: {
    title: string;
    author: string;
    description: string | null;
    status: string | null;
  };
}

/** What the edit endpoints return: the stored edit, or null once nothing is left of it. */
export type MangaOverrideRecord = Omit<MangaOverride, 'original'> & { manga_id: string };

/** Omit a field to leave it; null clears it back to the source's value. */
export interface UpdateMangaOverridePayload {
  title?: string | null;
  author?: string | null;
  description?: string | null;
  status?: string | null;
}

export interface MangaDetailSummary {
  status: string;
  genres: string;
  description: string;
  /** Null when the source never supplied one; the column itself is non-null and defaults
   * to "Unknown", so treat that string as "no artist" rather than a real credit. */
  artist: string | null;
  rating: number | null;
}

/** Shape returned by the library listing endpoints (GET /manga, GET /manga/category/:id). */
export interface MangaListItem extends Manga {
  chapter_count: number;
  latest_chapter_date: string | null;
  unread_count: number;
  /** Only populated by GET /manga; GET /manga/category/:id omits it. */
  manga_detail?: MangaDetailSummary | null;
}

/** A stored chapter. `id` is the app's own id for it: reads (progress, downloaded pages,
 * reader links) use it. Writes and anything sent to a source use `source_chapter_key`, the
 * source's own id for the chapter, which only names it within `source` + `manga_slug`. */
export interface MangaChapterRecord {
  id: string;
  source: string;
  manga_slug: string;
  source_chapter_key: string;
  manga_id: string | null;
  url: string;
  name: string | null;
  scanlator: string | null;
  is_read: boolean;
  is_bookmark: boolean;
  chapter_number: number;
  last_page_read: number;
  page_count: number | null;
  fetched_at: string | null;
  release_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface MangaWithDetails extends Manga {
  status: string;
  genres: string;
  description: string;
  rating: number | null;
  artist: string | null;
  chapters: MangaChapterRecord[];
}

export interface MangaCategoryLink {
  manga_id: string;
  category_id: string;
}

export interface MigrationSummary {
  /** Furthest chapter number read on the old entry; 0 if nothing was read. */
  progress: number;
  chapters_marked: number;
  categories_moved: number;
  history_moved: number;
  state_copied: boolean;
  old_entry_removed: boolean;
}

export interface MigrateMangaOptions {
  /** Take the old entry out of the library once everything has moved. Defaults to true
   * server-side. */
  remove_old?: boolean;
  /** Re-point the title's history rows at the new entry. Defaults to true server-side —
   * history keeps its own source/slug, so this preserves where each chapter was read. */
  move_history?: boolean;
}

/** Another source's copy of a title, as linked sources list it. */
export interface LinkedTitle {
  id: string;
  title: string;
  author: string;
  slug: string;
  source: string;
  thumbnail_url: string;
}

/** A title's group of sources: the library entry (`primary_id`) and the linked titles, in
 * the order they are tried. Asking with a linked title gives the same group. */
export interface MangaLinkGroup {
  primary_id: string;
  links: Array<{ id: string; priority: number; linked: LinkedTitle }>;
}

// ── notificationChannels ─────────────────────────────────────────────────────

/** An alert destination as the API shows it: never its URL or token, only the host. */
export interface NotificationChannel {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  destination: string;
  last_sent_at: string | null;
  last_error: string | null;
}

// ── restore ──────────────────────────────────────────────────────────────────

export type RestoreJob = {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: { restoredManga: number; restoredProgress: number; restoredHistory: number } | null;
  progress: { phase: string; completed: number; total: number } | null;
};

export type RestorePreview = {
  matchingTitles: number;
  addedTitles: number;
  importedTitles: number;
  catalogRowsUpdated: number;
  catalogUpdateExamples: string[];
  retainedHistory: number;
  addedHistory: number;
};

// ── source ───────────────────────────────────────────────────────────────────

export interface SourceSummary {
  id: string;
  name: string;
  lang: string;
  base_url: string;
  isNSFW: boolean;
  /** Where the source runs: an installed extension, or a connected Suwayomi server. Older
   * servers omit it, which means an extension. */
  provider?: 'extension' | 'suwayomi';
  /** The source's own icon, for sources without an installed extension record. */
  icon_url?: string | null;
}

export interface SourceOperationHealth {
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  retryAfterAt: string | null;
}

export interface SourceHealth {
  sourceId: string;
  browse: SourceOperationHealth | null;
  update: SourceOperationHealth | null;
}

export interface FetchMangaUpdatesResult {
  newChapters: number;
  /** The new chapters, for auto-download. Absent from older servers. */
  newChapterList?: Array<{
    source_chapter_key: string;
    chapter_number: number;
    name: string | null;
  }>;
  /** Stored chapters relinked to a new source id, updated or removed — changes to the
   * list that are not new chapters. Older servers omit it. */
  changedChapters?: number;
  thumbnail_url: string;
  /** Older servers omit this field; only true identifies a failed source check. */
  failed?: boolean;
}

export interface CheckLibraryUpdatesResult {
  /** Titles that couldn't be checked. */
  failed: number;
  checked: number;
  mangaWithNewChapters: number;
  totalNewChapters: number;
}

export interface SourceUrlKeys {
  /** False when the source cannot convert Mihon URLs at all. */
  supported: boolean;
  /** One title slug per requested manga URL, in order; null where unrecognised. */
  manga: Array<string | null>;
  /** One chapter key per requested chapter URL, in order; null where unrecognised. */
  chapters: Array<string | null>;
}

// ── suwayomi ─────────────────────────────────────────────────────────────────

/** The host's Suwayomi server connection. The password is never sent back: only
 * `has_password`. */
export interface SuwayomiSettings {
  enabled: boolean;
  url: string;
  username: string | null;
  has_password: boolean;
  /** False when the saved password can no longer be decrypted and has to be entered again. */
  password_readable: boolean;
}

/** What a connection test found on the server. */
export interface SuwayomiConnectionTest {
  name: string;
  version: string;
  sources: number;
}

/** A Mihon extension the Suwayomi server can install, installed or not. */
export interface SuwayomiExtension {
  pkg_name: string;
  name: string;
  lang: string;
  version: string;
  icon_url: string | null;
  is_nsfw: boolean;
  installed: boolean;
  has_update: boolean;
  obsolete: boolean;
}

// ── sync ─────────────────────────────────────────────────────────────────────

export interface SyncPullResult {
  generation: number;
  server_time: string;
  next_since: string;
  has_more: boolean;
  library: {
    id: string;
    user_id: string;
    manga_id: string;
    deleted_at: string | null;
    updated_at: string;
  }[];
  manga_state: {
    id: string;
    user_id: string;
    manga_id: string;
    is_bookmarked: boolean;
    shelf_status: string | null;
    notification_read: boolean;
    updated_at: string;
  }[];
  chapter_state: {
    id: string;
    user_id: string;
    source: string;
    manga_slug: string;
    source_chapter_key: string;
    is_read: boolean;
    is_bookmark: boolean;
    last_page_read: number;
    updated_at: string;
  }[];
  manga_category: {
    id: string;
    user_id: string;
    manga_id: string;
    category_id: string;
    deleted_at: string | null;
    updated_at: string;
  }[];
  history: {
    id: string;
    source: string;
    manga_id: string | null;
    manga_slug: string;
    title: string | null;
    thumbnail_url: string | null;
    source_chapter_key: string | null;
    read_at: string;
    last_read: string;
    pages_read: number;
    time_read: number;
    deleted_at: string | null;
  }[];
  categories: { id: string; name: string }[];
}

/** `failed` holds the ids of rows that couldn't be applied (e.g. referencing a manga/
 * chapter/category that no longer exists) — one bad row no longer aborts the rest of the
 * batch, so this is how a caller learns something didn't fully land. */
export interface DomainPushResult {
  applied: number;
  failed: string[];
}

export interface SyncPushResult {
  library: DomainPushResult;
  manga_state: DomainPushResult;
  chapter_state: DomainPushResult;
  manga_category: DomainPushResult;
  history: DomainPushResult;
}

// ── tracker ──────────────────────────────────────────────────────────────────

export type TrackerName = TrackerService;

/** How a tracker is connected: an OAuth redirect, a username/password, or a self-hosted
 * server URL plus API key. */
export type TrackerAuthKind = 'oauth' | 'password' | 'api_key';

export interface TrackerAvailability {
  tracker: TrackerName;
  label: string;
  auth_kind: TrackerAuthKind;
  /** False when the server is missing configuration this tracker needs. */
  available: boolean;
}

export interface ConnectedTracker {
  tracker: TrackerName;
  tracker_username: string;
  connected_at: string;
}

export interface TrackerSearchResult {
  tracker_media_id: string;
  title: string;
  cover_image_url: string | null;
}

export interface TrackerLink {
  id: string;
  user_id: string;
  manga_id: string;
  tracker: TrackerName;
  tracker_media_id: string;
  sync_enabled: boolean;
  last_synced_at: string | null;
}

export interface TrackerSyncResult {
  checked: number;
  updated: number;
}

// ── translate ────────────────────────────────────────────────────────────────

/** Whether pages can be translated for this reader, and with which service. */
export interface TranslateStatus {
  enabled: boolean;
  provider: TranslateProvider | null;
  /** Whose service answers: the reader's own saved one, or the host's. Older servers omit it. */
  origin?: 'account' | 'server' | null;
  /** Whether the host set a service of its own. Older servers omit it. */
  server_configured?: boolean;
  source: 'ja';
}

/** The reader's own translation service. The API key is never sent back: only `has_key`. */
export interface TranslateSettings {
  provider: TranslateProvider;
  url: string | null;
  has_key: boolean;
  /** False when the saved key can no longer be decrypted and has to be entered again. */
  key_readable: boolean;
  updated_at: string;
}

// ── updateLog ────────────────────────────────────────────────────────────────

export interface UpdateLogEntry {
  id: string;
  source_id: string;
  manga_id: string | null;
  kind: UpdateLogKind;
  message: string;
  detail: string;
  created_at: string;
  manga: { id: string; slug: string; title: string; thumbnail_url: string } | null;
}
