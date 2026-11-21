import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import downloadService from '../src/services/download.service.js';

/**
 * A test run must never use the real Downloads folder. It used to: the service's default
 * folder was ~/Downloads/ProjektManga in tests too, so a run created it, and the restore
 * scan (which looks in every folder downloads were saved to) counted whatever the developer
 * had downloaded there alongside the test's own folders, failing on their machine only.
 */
describe('downloads under test', () => {
  const realDownloads = path.join(os.homedir(), 'Downloads', 'ProjektManga');
  const isUnder = (dir: string, root: string) => {
    const relative = path.relative(root, dir);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  it('keeps the download folder out of the real Downloads folder', () => {
    if (process.env.DOWNLOAD_DIR) return; // A run given its own folder uses that one.
    expect(isUnder(downloadService.getDownloadDir(), realDownloads)).toBe(false);
    expect(isUnder(downloadService.getDownloadDir(), os.tmpdir())).toBe(true);
  });

  it('never scans the real Downloads folder for downloads to restore', () => {
    for (const root of downloadService.getKnownDownloadRoots()) {
      expect(isUnder(root, realDownloads)).toBe(false);
    }
  });
});
