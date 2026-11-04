/**
 * Writes a release's description and SHA256SUMS.txt from the built installer files and
 * apps/web/src/data/changelog.json, so neither is written by hand. The release workflow
 * uploads both to the draft.
 *
 *   node scripts/release-notes.mjs <folder holding the installer> [output folder]
 *
 * A changelog entry may carry `summary` (the opening paragraph) and `upgrade` (a section
 * shown only when a release needs one).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'Zero0blanK/Projekt-Manga';
const SECTIONS = [
  ['added', 'Added'],
  ['changed', 'Changed'],
  ['fixed', 'Fixed'],
  ['removed', 'Removed'],
];

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** The release description, in the layout every release uses. */
export function renderNotes(release, previousVersion, files) {
  const { version } = release;
  const installer = `Projekt-Manga-Setup-${version}.exe`;
  const hash = files.find((file) => file.name === installer).sha256;
  const rows = files.map((file) => {
    const label =
      file.name === installer
        ? `[\`${file.name}\`](https://github.com/${REPOSITORY}/releases/download/v${version}/${file.name})`
        : `\`${file.name}\``;
    return `| ${label} | ${formatSize(file.size)} | \`${file.sha256}\` |`;
  });
  const changes = SECTIONS.flatMap(([type, title]) => {
    const items = release.changes.filter((change) => change.type === type);
    if (!items.length) return [];
    return [`### ${title}`, ...items.map((item) => `- ${item.text}`), ''];
  });
  return [
    ...(release.summary ? [release.summary, ''] : []),
    `**Released:** ${release.date} · **Version:** ${version} · **Platform:** Windows 10 and 11 (64-bit)`,
    '',
    '## Downloads',
    '',
    '| File | Size | SHA-256 |',
    '|---|---|---|',
    ...rows,
    '| `SHA256SUMS.txt` | | all of the above |',
    '',
    "You only need the `.exe`. The `.blockmap` and `latest.yml` are used by the app's built-in updater.",
    '',
    '### Verify the download',
    '',
    'In PowerShell, from the folder you downloaded to:',
    '',
    '```powershell',
    `Get-FileHash .\\${installer} -Algorithm SHA256`,
    '```',
    '',
    `The hash must match \`${hash}\`. If it doesn't, don't run the file; download it again from this page.`,
    '',
    '## Install',
    '',
    `1. Run \`${installer}\`. It installs over ${previousVersion} in place.`,
    '2. **This build isn\'t code-signed yet,** so Windows SmartScreen may say it "prevented an unrecognized app from starting". Choose **More info → Run anyway**. Verifying the checksum above confirms the file is the one published here.',
    '',
    'Your library, settings and downloads stay in `%APPDATA%\\@projekt-manga\\desktop`.',
    '',
    '## What changed',
    '',
    ...changes,
    ...(release.upgrade ? ['## Upgrading', '', release.upgrade, ''] : []),
    '## Updates',
    '',
    `${previousVersion} should offer this version itself with **Update now**, **Later** and **Skip this version**. If it doesn't, download ${version} from this page and install it over your current version.`,
    '',
  ].join('\n');
}

export function renderChecksums(files) {
  return files.map((file) => `${file.sha256} *${file.name}\n`).join('');
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const [releaseDir, outputDir = releaseDir] = process.argv.slice(2);
  if (!releaseDir) throw new Error('Usage: release-notes.mjs <release folder> [output folder]');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const changelog = JSON.parse(
    await readFile(path.join(root, 'apps/web/src/data/changelog.json'), 'utf8'),
  );
  const [release, previous] = changelog.releases;
  const installer = `Projekt-Manga-Setup-${release.version}.exe`;
  const files = [];
  for (const name of [installer, `${installer}.blockmap`, 'latest.yml']) {
    const filePath = path.join(releaseDir, name);
    files.push({ name, size: (await stat(filePath)).size, sha256: await sha256(filePath) });
  }
  await writeFile(path.join(outputDir, 'SHA256SUMS.txt'), renderChecksums(files));
  await writeFile(
    path.join(outputDir, 'release-notes.md'),
    renderNotes(release, previous?.version ?? 'an earlier version', files),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
