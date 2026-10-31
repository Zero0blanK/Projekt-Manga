/** Server-side automatic backup settings. These live on the server rather than in client
 * settings because the scheduler runs without any browser attached. */
export interface BackupConfig {
  /** Hours between automatic backups; 0 turns the scheduler off. */
  intervalHours: number;
  /** Newest automatic backups kept per owner; older ones are deleted. */
  keep: number;
}

export interface BackupFileInfo {
  /** File name only (`projektmanga-<timestamp>.json`); never a path. */
  name: string;
  createdAt: string;
  size: number;
}

export interface BackupStatus {
  config: BackupConfig;
  /** Newest first. */
  files: BackupFileInfo[];
  lastBackupAt: string | null;
  /** Absolute folder holding this owner's backups, for the desktop "Open folder" action. */
  folder: string;
}

/** The version-2 export: what Settings → Privacy downloads and what restore reads. The
 * server fills everything but `settings`, which only the browser holds. */
export interface ReadingDataExport {
  exportedAt: string;
  version: 2;
  manga: unknown[];
  library: unknown[];
  history: unknown[];
  downloads: unknown[];
  settings: unknown;
}
