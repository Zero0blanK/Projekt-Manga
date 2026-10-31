// Copies the page-translation OCR engine (tesseract.js's worker and WASM core) and its
// Japanese vertical-text model into public/ocr, so the app serves them itself: by default
// tesseract.js fetches all three from a CDN, and the point of reading text on the device is
// that nothing about the page has to leave it. Run before `next dev` and `next build`.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const out = path.join(here, '..', 'public', 'ocr');

const tesseract = path.dirname(require.resolve('tesseract.js/package.json'));
const core = path.dirname(require.resolve('tesseract.js-core/package.json'));
const language = path.dirname(require.resolve('@tesseract.js-data/jpn_vert/package.json'));

const files = [
  [path.join(tesseract, 'dist', 'worker.min.js'), 'worker.min.js'],
  // tesseract.js picks the fastest build the browser supports from these.
  ...['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm'].flatMap(
    (name) => [
      [path.join(core, `${name}.wasm.js`), path.join('core', `${name}.wasm.js`)],
      [path.join(core, `${name}.wasm`), path.join('core', `${name}.wasm`)],
    ],
  ),
  [
    path.join(language, '4.0.0_best_int', 'jpn_vert.traineddata.gz'),
    path.join('lang', 'jpn_vert.traineddata.gz'),
  ],
];

for (const [from, to] of files) {
  const target = path.join(out, to);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(from, target);
}
console.log(`OCR assets copied to ${path.relative(process.cwd(), out)}`);
