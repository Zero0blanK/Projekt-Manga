import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * The models behind local page translation, downloaded once on first use and kept:
 *
 * - manga-ocr (kha-white, Apache-2.0), Japanese text recognition made for manga speech
 *   bubbles: the quantized ONNX export from onnx-community, and the original vocabulary.
 * - FuguMT Japanese→English (staka/fugumt-ja-en, CC-BY-SA-4.0, a Marian model trained on
 *   far more Japanese than Opus-MT), via Kadonox's ONNX export for Transformers.js.
 *
 * Every file is pinned to a revision and checked against its SHA-256 before it is used, so
 * the server only ever runs the exact files listed here, whatever the host serves later.
 * They go to TRANSLATION_MODELS_DIR (the desktop app points it at its data folder), else
 * `<cwd>/data/translation-models`.
 */

const HUB = 'https://huggingface.co';

interface ModelFile {
  repo: string;
  revision: string;
  path: string;
  bytes: number;
  sha256: string;
}

const MANGA_OCR_REVISION = 'f9023406bb2f6b17df67bc4a327c56ecd20611f0';
const MANGA_OCR_VOCAB_REVISION = 'aa6573bd10b0d446cbf622e29c3e084914df9741';
const TRANSLATOR_REVISION = '9b09cd7e6263223ac4a5988da1d881ef02b55be8';

export const MANGA_OCR_REPO = 'onnx-community/manga-ocr-base-ONNX';
export const MANGA_OCR_VOCAB_REPO = 'kha-white/manga-ocr-base';
/** Speech bubbles and text on a page: RT-DETR-v2 trained on about 11k manga, webtoon, manhua
 * and western comic pages (ogkalu, Apache-2.0). */
export const TEXT_DETECTOR_REPO = 'ogkalu/comic-text-and-bubble-detector';
const TEXT_DETECTOR_REVISION = '16e8a622f91fabc6b5b65c96d32d1183f8843546';
export const TRANSLATOR_REPO = 'Kadonox/fugumt-ja-en-onnx';

/** Models an earlier version downloaded and no longer uses: removed once the current ones are
 * in, so an update doesn't leave them taking up the disk. */
export const RETIRED_REPOS = ['Xenova/opus-mt-ja-en'];

export const MODEL_FILES: readonly ModelFile[] = [
  {
    repo: MANGA_OCR_REPO,
    revision: MANGA_OCR_REVISION,
    path: 'onnx/encoder_model_quantized.onnx',
    bytes: 86967767,
    sha256: 'ddd1af56963093795705fa38da6ce7e6567d1658e7c7359db7e13fcd37dbf279',
  },
  {
    repo: MANGA_OCR_REPO,
    revision: MANGA_OCR_REVISION,
    path: 'onnx/decoder_model_quantized.onnx',
    bytes: 29627936,
    sha256: '2e7177d2b0a59f1c612b694ed70c13971bee765cc2b2bc7bc9376e4753652f27',
  },
  {
    repo: MANGA_OCR_VOCAB_REPO,
    revision: MANGA_OCR_VOCAB_REVISION,
    path: 'vocab.txt',
    bytes: 24072,
    sha256: '344fbb6b8bf18c57839e924e2c9365434697e0227fac00b88bb4899b78aa594d',
  },
  {
    repo: TEXT_DETECTOR_REPO,
    revision: TEXT_DETECTOR_REVISION,
    path: 'detector-v4-s_int8.onnx',
    bytes: 11120765,
    sha256: '5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79',
  },
  ...(
    [
      ['config.json', 1045, '24e201e35f20db82adcd87924d59398bf986560a46532d01fb2ae19cf606f17f'],
      [
        'generation_config.json',
        289,
        '23a8b82900404c37f3f85170507dbc929dc3a6be1ba24fe340d9336d1cf841da',
      ],
      [
        'tokenizer.json',
        3169716,
        'e0bb9bef12bb06c118b2bcf7e6ec5975a0dfa3d89191df6cc331767b1643af78',
      ],
      [
        'tokenizer_config.json',
        280,
        '414e9e7e2492b95fa80f24ccb295645d35c4dd0a74d7ef8b89820c0c7e8ec356',
      ],
      [
        'onnx/encoder_model_quantized.onnx',
        35979078,
        'caea82d93435b76cd01edcb9dfb6dbfce82bde435bdc739a198a298014884b06',
      ],
      [
        'onnx/decoder_model_merged_quantized.onnx',
        108678224,
        'faf90e39de2b027461f09297f7edc83734c24c00bcfb1482c7ec1ca77e84a989',
      ],
    ] as const
  ).map(([file, bytes, sha256]) => ({
    repo: TRANSLATOR_REPO,
    revision: TRANSLATOR_REVISION,
    path: file,
    bytes,
    sha256,
  })),
];

export const TOTAL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0);

export function modelsDir(): string {
  return path.resolve(
    process.env.TRANSLATION_MODELS_DIR || path.join(process.cwd(), 'data', 'translation-models'),
  );
}

/** Where a model file lives on disk: `<dir>/<repo>/<path>`, the layout Transformers.js reads. */
export function localPath(file: Pick<ModelFile, 'repo' | 'path'>): string {
  return path.join(modelsDir(), ...file.repo.split('/'), ...file.path.split('/'));
}

/** The host can turn local translation off (for a small server, or to save the disk). */
export function localTranslationEnabled(): boolean {
  return process.env.LOCAL_TRANSLATION?.trim().toLowerCase() !== 'off';
}

export type ModelsState =
  | { state: 'missing' }
  | { state: 'downloading'; downloaded: number; total: number }
  | { state: 'ready' }
  | { state: 'error'; message: string };

let downloading: Promise<void> | null = null;
let progress = 0;
let lastError: string | null = null;
let verified = false;

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

async function hasFile(file: ModelFile): Promise<boolean> {
  try {
    return (await fs.stat(localPath(file))).size === file.bytes;
  } catch {
    return false;
  }
}

/** Fetches one file to a temporary name, checks its size and hash, then moves it into place. */
async function fetchFile(file: ModelFile, onBytes: (bytes: number) => void): Promise<void> {
  const target = localPath(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  const url = `${HUB}/${file.repo}/resolve/${file.revision}/${file.path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) {
    throw new Error(`The model download failed (HTTP ${response.status})`);
  }
  const hash = createHash('sha256');
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > file.bytes) return done(new Error('A model file was larger than expected'));
      hash.update(chunk);
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(partial));
    if (received !== file.bytes || hash.digest('hex') !== file.sha256) {
      throw new Error("A downloaded model file didn't match its checksum");
    }
    await fs.rename(partial, target);
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }
}

async function downloadAll(): Promise<void> {
  progress = 0;
  lastError = null;
  for (const file of MODEL_FILES) {
    if (await hasFile(file)) {
      progress += file.bytes;
      continue;
    }
    await fetchFile(file, (bytes) => {
      progress += bytes;
    });
  }
  verified = true;
  await removeRetiredModels();
}

/** Best effort: a leftover folder only costs disk space. */
async function removeRetiredModels(): Promise<void> {
  for (const repo of RETIRED_REPOS) {
    await fs
      .rm(path.join(modelsDir(), ...repo.split('/')), { recursive: true, force: true })
      .catch(() => undefined);
  }
}

/** Starts the download if it isn't running or done; resolves when the models are ready. */
export function ensureModels(): Promise<void> {
  if (verified) return Promise.resolve();
  downloading ??= downloadAll()
    .catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : 'The model download failed';
      throw error;
    })
    .finally(() => {
      downloading = null;
    });
  return downloading;
}

export async function modelsState(): Promise<ModelsState> {
  if (verified) return { state: 'ready' };
  if (downloading) return { state: 'downloading', downloaded: progress, total: TOTAL_BYTES };
  const present = await Promise.all(MODEL_FILES.map(hasFile));
  if (present.every(Boolean)) {
    verified = true;
    void removeRetiredModels();
    return { state: 'ready' };
  }
  if (lastError) return { state: 'error', message: lastError };
  return { state: 'missing' };
}

/** For tests. */
export function resetModelsState(): void {
  downloading = null;
  progress = 0;
  lastError = null;
  verified = false;
}
