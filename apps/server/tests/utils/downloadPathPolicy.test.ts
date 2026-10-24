import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DownloadPathPolicy } from '../../src/utils/downloadPathPolicy.js';

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-download-roots-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('DownloadPathPolicy', () => {
  it('remembers explicitly approved roots across service restarts', () => {
    const stateDir = makeTempDir();
    const approvedRoot = path.join(stateDir, 'chosen-downloads');
    const chapterDir = path.join(approvedRoot, 'chapter');
    const elsewhere = path.join(stateDir, 'private');
    fs.mkdirSync(chapterDir, { recursive: true });
    fs.mkdirSync(elsewhere);
    const registry = path.join(stateDir, 'download-roots.json');

    new DownloadPathPolicy(registry, [approvedRoot]);
    const restarted = new DownloadPathPolicy(registry, [], false);

    expect(restarted.resolveAllowedExistingPath(chapterDir)).toBe(fs.realpathSync(chapterDir));
    expect(restarted.resolveAllowedExistingPath(approvedRoot)).toBeNull();
    expect(restarted.resolveAllowedExistingPath(elsewhere)).toBeNull();
  });

  it('rejects chapter directories and page files reached through escaping symlinks', (ctx) => {
    const stateDir = makeTempDir();
    const approvedRoot = path.join(stateDir, 'downloads');
    const outside = path.join(stateDir, 'outside');
    fs.mkdirSync(approvedRoot);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'page_001.jpg'), 'private');
    const registry = path.join(stateDir, 'download-roots.json');
    const policy = new DownloadPathPolicy(registry, [approvedRoot], false);

    try {
      fs.symlinkSync(outside, path.join(approvedRoot, 'linked-chapter'), 'junction');
    } catch {
      ctx.skip();
      return;
    }

    const linkedChapter = path.join(approvedRoot, 'linked-chapter');
    fs.mkdirSync(path.join(approvedRoot, 'chapter'));
    try {
      fs.symlinkSync(
        path.join(outside, 'page_001.jpg'),
        path.join(approvedRoot, 'chapter', 'page_001.jpg'),
        'file',
      );
    } catch {
      expect(policy.resolveAllowedExistingPath(linkedChapter)).toBeNull();
      return;
    }
    const pageLink = path.join(approvedRoot, 'chapter', 'page_001.jpg');
    expect(policy.resolveAllowedExistingPath(linkedChapter)).toBeNull();
    expect(policy.containsRealPath(path.join(approvedRoot, 'chapter'), pageLink)).toBe(false);
  });
});
