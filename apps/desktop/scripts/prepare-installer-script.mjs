/**
 * Writes build/nsis/extractUsing7za.nsh: electron-builder's own 7z extraction step, changed to
 * list every file in the installer's progress page.
 *
 * electron-builder packs the whole app into one 7z archive and unpacks it with
 * `Nsis7z::Extract`, which shows a bar and nothing else, so a large install looked stuck.
 * `Nsis7z::ExtractWithDetails` reports each file as it is unpacked. build/installer.nsh swaps
 * this macro in through electron-builder's `customCheckAppRunning` hook, which runs just
 * before extraction (a custom installer script would also stop electron-builder from
 * building the uninstaller).
 *
 * The macro is copied from the installed electron-builder at build time rather than vendored,
 * so an upgrade can't leave a stale copy behind; if the template no longer has the text this
 * changes, the build stops instead of silently shipping the plain installer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(desktop, 'package.json'));
const template = path.join(
  path.dirname(require.resolve('app-builder-lib/package.json')),
  'templates',
  'nsis',
  'include',
  'extractAppPackage.nsh',
);
const out = path.join(desktop, 'build', 'nsis');

const source = fs.readFileSync(template, 'utf8');
const start = source.indexOf('!macro extractUsing7za FILE');
const end = source.indexOf('!macroend', start);
if (start < 0 || end < 0) {
  throw new Error('[installer-script] extractUsing7za is missing from electron-builder');
}
let macro = source.slice(start, end + '!macroend'.length);

const replacements = [
  [
    '  Nsis7z::Extract "${FILE}"\n  Pop $R0',
    '  DetailPrint "Unpacking ${PRODUCT_NAME}..."\n' +
      '  Nsis7z::ExtractWithDetails "${FILE}" "Extracting %s..."\n  Pop $R0',
  ],
  [
    '    # Attempt to copy files in atomic way\n',
    '    # Attempt to copy files in atomic way\n    DetailPrint "Copying files to $OUTDIR..."\n',
  ],
];
for (const [find, replace] of replacements) {
  if (!macro.includes(find)) {
    throw new Error(`[installer-script] extractUsing7za no longer contains: ${find}`);
  }
  macro = macro.replace(find, replace);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'extractUsing7za.nsh'), `${macro}\n`);
console.log(
  `[installer-script] wrote ${path.relative(desktop, path.join(out, 'extractUsing7za.nsh'))}`,
);
