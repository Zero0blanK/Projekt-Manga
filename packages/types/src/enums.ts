/**
 * The closed value sets that used to be Prisma enums.
 *
 * SQLite has no enum type, so `schema.prisma` declares these columns as `String`. Left at
 * that, every one of them would silently widen to `string` throughout the server —
 * `shelf_status` could be assigned `"REEDING"` and nothing would complain until a tracker
 * sync produced nonsense. These unions put the compile-time check back; the matching Zod
 * schemas in `packages/schemas` put the runtime check back at the boundary.
 *
 * The `*_VALUES` arrays are the single source of truth: the union is derived from the
 * array, so adding a value in one place cannot leave the other behind. They also give the
 * runtime something to validate against, which a bare type cannot.
 *
 * These strings are persisted, so they are not free to rename — a change here is a data
 * migration, exactly as an enum change was.
 */

export const MANGA_STATUS_VALUES = [
  'ONGOING',
  'COMPLETED',
  'HIATUS',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type MangaStatus = (typeof MANGA_STATUS_VALUES)[number];

export const DOWNLOAD_STATUS_VALUES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'] as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUS_VALUES)[number];

export const SHELF_STATUS_VALUES = ['READING', 'COMPLETED', 'ON_HOLD', 'PLAN', 'DROPPED'] as const;
export type ShelfStatus = (typeof SHELF_STATUS_VALUES)[number];

export const UPDATE_LOG_KIND_VALUES = ['NEW_CHAPTER', 'ERROR'] as const;
export type UpdateLogKind = (typeof UPDATE_LOG_KIND_VALUES)[number];

export const DEVICE_PLATFORM_VALUES = ['WEB', 'DESKTOP'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORM_VALUES)[number];

export const TRACKER_SERVICE_VALUES = ['ANILIST', 'MYANIMELIST'] as const;
export type TrackerService = (typeof TRACKER_SERVICE_VALUES)[number];

/** Narrowing helper for the many places that read one of these back out of the database,
 * where the column's type is now only `string`. */
function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const isMangaStatus = (v: unknown): v is MangaStatus => isMember(MANGA_STATUS_VALUES, v);
export const isDownloadStatus = (v: unknown): v is DownloadStatus =>
  isMember(DOWNLOAD_STATUS_VALUES, v);
export const isShelfStatus = (v: unknown): v is ShelfStatus => isMember(SHELF_STATUS_VALUES, v);
export const isUpdateLogKind = (v: unknown): v is UpdateLogKind =>
  isMember(UPDATE_LOG_KIND_VALUES, v);
export const isDevicePlatform = (v: unknown): v is DevicePlatform =>
  isMember(DEVICE_PLATFORM_VALUES, v);
export const isTrackerService = (v: unknown): v is TrackerService =>
  isMember(TRACKER_SERVICE_VALUES, v);
