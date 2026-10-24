import {
  ApiError,
  cancelDownload,
  deleteHistory,
  getAllDownloads,
  getHistory,
  getManga,
  getServerHistory,
  getServerManga,
  hasLocalDataBridge,
  localInvoke,
  setMangaInLibrary,
} from '@projekt-manga/api-client';
export type WipeSelection = {
  library: boolean;
  history: boolean;
  downloads: boolean;
};

export type WipeCategory = keyof WipeSelection;
export type WipeCount = { removed: number; skipped: number; failed: number; readFailed: boolean };
export type WipeReport = Record<WipeCategory, WipeCount>;
export type WipeInventory = Record<WipeCategory, number | null>;

const emptyCount = (): WipeCount => ({ removed: 0, skipped: 0, failed: 0, readFailed: false });

function alreadyGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

async function attempt(
  count: WipeCount,
  operation: () => Promise<unknown>,
  countRemoved = true,
): Promise<void> {
  try {
    await operation();
    if (countRemoved) count.removed++;
  } catch (error) {
    if (alreadyGone(error)) count.skipped++;
    else count.failed++;
  }
}

async function inventory<T>(count: WipeCount, read: () => Promise<T[]>): Promise<T[] | null> {
  try {
    return await read();
  } catch {
    count.readFailed = true;
    return null;
  }
}

/** Counts shown before confirmation. A failed read is unknown, never displayed as zero. */
export async function getWipeInventory(): Promise<WipeInventory> {
  const desktop = hasLocalDataBridge();
  const [serverLibrary, localLibrary, serverHistory, localHistory, downloads] =
    await Promise.allSettled([
      getServerManga(),
      desktop ? getManga() : Promise.resolve([]),
      getServerHistory(),
      desktop ? getHistory() : Promise.resolve([]),
      getAllDownloads(),
    ]);
  const countUnique = (
    server: typeof serverLibrary | typeof serverHistory,
    local: typeof localLibrary | typeof localHistory,
  ): number | null => {
    if (server.status === 'rejected' || local.status === 'rejected') return null;
    return new Set([...server.value.map((item) => item.id), ...local.value.map((item) => item.id)])
      .size;
  };
  return {
    library: countUnique(serverLibrary, localLibrary),
    history: countUnique(serverHistory, localHistory),
    downloads: downloads.status === 'fulfilled' ? downloads.value.length : null,
  };
}

/** Each category and item is independent: a missing row or failed request must not
 * prevent the remaining selected data from being processed. Unreadable inventories are
 * reported, never assumed empty. */
export async function wipeSelectedData(selection: WipeSelection): Promise<WipeReport> {
  const report: WipeReport = {
    library: emptyCount(),
    history: emptyCount(),
    downloads: emptyCount(),
  };
  const desktop = hasLocalDataBridge();

  if (selection.downloads) {
    const items = await inventory(report.downloads, getAllDownloads);
    if (items) {
      for (const item of items) await attempt(report.downloads, () => cancelDownload(item.id));
    }
  }

  if (selection.library) {
    const server = await inventory(report.library, () => getServerManga());
    const local = desktop ? await inventory(report.library, () => getManga()) : [];
    if (server) {
      for (const item of server) {
        await attempt(report.library, () => setMangaInLibrary(item.id, false));
      }
    }
    // The API's mirror is best-effort; clear every local row explicitly so a failed
    // mirror cannot leave a stale library entry after the wipe.
    if (local) {
      const serverIds = new Set(server?.map((item) => item.id) ?? []);
      for (const item of local) {
        await attempt(
          report.library,
          () => localInvoke('manga', 'setInLibrary', { mangaId: item.id, inLibrary: false }),
          !serverIds.has(item.id),
        );
      }
    }
  }

  if (selection.history) {
    const server = await inventory(report.history, getServerHistory);
    const local = desktop ? await inventory(report.history, getHistory) : [];
    if (server) {
      for (const item of server) await attempt(report.history, () => deleteHistory(item.id));
    }
    if (local) {
      const serverIds = new Set(server?.map((item) => item.id) ?? []);
      for (const item of local) {
        await attempt(
          report.history,
          () => localInvoke('history', 'delete', { id: item.id }),
          !serverIds.has(item.id),
        );
      }
    }
  }

  return report;
}
