import type {
  BackupConfig,
  BackupFileInfo,
  BackupStatus,
  ReadingDataExport,
} from '@projekt-manga/types';
import type { UpdateBackupConfigBody } from '@projekt-manga/schemas';
import mangaService from './manga.service.js';
import libraryService from './library.service.js';
import historyService from './history.service.js';
import downloadService from './download.service.js';
import userRepository from '../repositories/user.repository.js';
import mangaLinkRepository from '../repositories/mangaLink.repository.js';
import { NotFoundError } from '../utils/customErrors.js';
import {
  listBackups,
  ownerDir,
  ownerKey,
  pruneBackups,
  readBackup,
  readBackupConfig,
  writeBackup,
  writeBackupConfig,
} from '../utils/backupStore.js';

/**
 * Builds the version-2 export for one owner (`undefined` = anonymous), exactly as the
 * browser used to assemble it from the list, detail, library, history and download
 * endpoints — only without the HTTP round trips, so the scheduler can run it too.
 *
 * `settings` is always null: preferences live in the browser, which merges its own in
 * before a manual export is saved. A restore treats a missing settings block as "keep the
 * current preferences".
 */
export async function buildExport(userId?: string): Promise<ReadingDataExport> {
  const [libraryManga, library, history, downloads] = await Promise.all([
    mangaService.getManga({}, userId),
    libraryService.getLibraryState(userId),
    historyService.getHistory(userId),
    downloadService.getAllDownloads(),
  ]);
  // A title removed between the list and this read is left out: it's no longer in the library.
  const found = await mangaService.getMangaDetailsByIds(
    libraryManga.map((entry) => entry.id),
    userId,
  );
  // Each title's linked sources travel with it, by source and slug: a linked title is
  // usually outside the library, so it isn't an entry of its own.
  const links = await mangaLinkRepository.linksForPrimaries(
    found.map((entry) => entry.id),
    userId ?? null,
  );
  const manga = found.map((entry) => {
    const linked = links.get(entry.id);
    return linked?.length
      ? {
          ...entry,
          links: linked.map(({ priority, linked: title }) => ({
            source: title.source,
            slug: title.slug,
            title: title.title,
            author: title.author,
            thumbnail_url: title.thumbnail_url,
            priority,
          })),
        }
      : entry;
  });
  // Restore refuses library state for a title the file does not carry, so a state row
  // left over for a title outside the library would make the whole backup unrestorable.
  const exported = new Set(manga.map((entry) => entry.id));
  const payload: ReadingDataExport = {
    exportedAt: new Date().toISOString(),
    version: 2,
    manga,
    library: (library as Array<{ manga_id: string }>).filter((state) =>
      exported.has(state.manga_id),
    ),
    history,
    downloads,
    settings: null,
  };
  // Through JSON once so Dates are ISO strings here exactly as they are in a downloaded
  // file — the restore schema validates the serialized form.
  return JSON.parse(JSON.stringify(payload)) as ReadingDataExport;
}

/** One write per owner at a time: "Back up now" during a scheduled run would otherwise
 * build the same export twice and race the pruning. */
const inFlight = new Map<string, Promise<BackupFileInfo>>();

export function createBackup(userId?: string): Promise<BackupFileInfo> {
  const owner = ownerKey(userId);
  const running = inFlight.get(owner);
  if (running) return running;
  const job = (async () => {
    const payload = await buildExport(userId);
    const file = await writeBackup(owner, JSON.stringify(payload, null, 2));
    const { keep } = await readBackupConfig();
    await pruneBackups(owner, keep);
    return file;
  })().finally(() => inFlight.delete(owner));
  inFlight.set(owner, job);
  return job;
}

export async function getBackupStatus(userId?: string): Promise<BackupStatus> {
  const owner = ownerKey(userId);
  const [config, files] = await Promise.all([readBackupConfig(), listBackups(owner)]);
  return { config, files, lastBackupAt: files[0]?.createdAt ?? null, folder: ownerDir(owner) };
}

export async function getBackupFile(name: string, userId?: string): Promise<string> {
  try {
    return await readBackup(ownerKey(userId), name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError('Backup not found');
    }
    throw error;
  }
}

export async function updateBackupConfig(patch: UpdateBackupConfigBody): Promise<BackupConfig> {
  const config = { ...(await readBackupConfig()), ...patch };
  await writeBackupConfig(config);
  return config;
}

/**
 * One scheduler pass: backs up every owner whose newest backup is older than the interval.
 *
 * Anonymous data and each account are separate owners with separate folders, so a backup
 * never mixes one person's history into another's. An owner with nothing in the library
 * and no history is skipped — a fresh install should not fill its disk with empty files.
 * One owner failing does not stop the others.
 */
export async function runScheduledBackups(now = Date.now()): Promise<number> {
  const { intervalHours } = await readBackupConfig();
  if (intervalHours <= 0) return 0;
  const owners: Array<string | undefined> = [undefined, ...(await userRepository.listIds())];
  let written = 0;
  for (const userId of owners) {
    try {
      const [newest] = await listBackups(ownerKey(userId));
      if (newest && now - Date.parse(newest.createdAt) < intervalHours * 60 * 60 * 1000) continue;
      const [manga, history] = await Promise.all([
        mangaService.getManga({}, userId),
        historyService.getHistory(userId),
      ]);
      if (manga.length === 0 && history.length === 0) continue;
      await createBackup(userId);
      written++;
    } catch (error) {
      console.warn(`[Backups] Automatic backup failed for ${ownerKey(userId)}:`, error);
    }
  }
  return written;
}

/** How often the scheduler checks who is due. The interval itself is per backup age, so an
 * interval changed from Settings applies on the next check without restarting a timer. */
const BACKUP_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** Same reasoning as the extension update check: let startup finish first. */
const BACKUP_INITIAL_DELAY_MS = 60_000;

export function startBackupScheduler(): void {
  const run = async () => {
    try {
      const written = await runScheduledBackups();
      if (written > 0) console.log(`[Backups] Wrote ${written} automatic backup(s)`);
    } catch (error) {
      console.warn('[Backups] Scheduled backup could not run:', error);
    }
  };
  // unref() so a pending timer never holds the process open on shutdown.
  setTimeout(() => void run(), BACKUP_INITIAL_DELAY_MS).unref();
  setInterval(() => void run(), BACKUP_CHECK_INTERVAL_MS).unref();
}
