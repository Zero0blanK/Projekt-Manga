import fs from 'node:fs/promises';
import { ServiceUnavailableError, ValidationError } from '../utils/customErrors.js';
import { detectRasterImageType } from '../utils/imageContent.js';
import {
  MODEL_FILES,
  MANGA_OCR_REPO,
  MANGA_OCR_VOCAB_REPO,
  TRANSLATOR_REPO,
  TOTAL_BYTES,
  ensureModels,
  localPath,
  localTranslationEnabled,
  modelsDir,
  modelsState,
} from './translationModels.service.js';
import { detectText, placeText } from './textDetection.service.js';

/**
 * Local page translation, on this server: manga-ocr reads the Japanese in each speech
 * bubble the device cropped out, and FuguMT translates it to English. Nothing leaves the
 * server. The models download on first use (translationModels.service.ts).
 *
 * manga-ocr runs on ONNX Runtime directly (a vision encoder, then a character decoder
 * stepped greedily: bubbles are short). FuguMT runs through Transformers.js, one line at a
 * time: batched lines are padded, and the padded ones ran on past their end. Both libraries
 * are imported on first use, so a server that never translates doesn't load them. One job
 * runs at a time: inference already uses every core.
 */

/** manga-ocr's ViT input, and the decoder's start/end tokens (its generation config). */
const IMAGE_SIZE = 224;
const DECODER_START = 2;
const END_OF_TEXT = 3;
const MAX_TOKENS = 300;
const MAX_IMAGE_PIXELS = 4096 * 4096;

type Ort = typeof import('onnxruntime-node');
type Session = import('onnxruntime-node').InferenceSession;

interface MangaOcr {
  ort: Ort;
  encoder: Session;
  decoder: Session;
  vocab: string[];
}

type Translator = (
  text: string,
  options: Record<string, unknown>,
) => Promise<Array<{ translation_text?: string }>>;

let ocrModel: Promise<MangaOcr> | null = null;
let translator: Promise<Translator> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Runs `work` after everything already queued, so jobs never compete for the CPU. */
function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

const fileOf = (repo: string, file: string) =>
  localPath(MODEL_FILES.find((entry) => entry.repo === repo && entry.path === file)!);

function loadOcr(): Promise<MangaOcr> {
  ocrModel ??= (async () => {
    const ort = (await import('onnxruntime-node')) as unknown as Ort;
    const options = { graphOptimizationLevel: 'all' as const };
    const [encoder, decoder, vocab] = await Promise.all([
      ort.InferenceSession.create(
        fileOf(MANGA_OCR_REPO, 'onnx/encoder_model_quantized.onnx'),
        options,
      ),
      ort.InferenceSession.create(
        fileOf(MANGA_OCR_REPO, 'onnx/decoder_model_quantized.onnx'),
        options,
      ),
      fs.readFile(fileOf(MANGA_OCR_VOCAB_REPO, 'vocab.txt'), 'utf8'),
    ]);
    return { ort, encoder, decoder, vocab: vocab.split(/\r?\n/) };
  })().catch((error) => {
    ocrModel = null;
    throw error;
  });
  return ocrModel;
}

function loadTranslator(): Promise<Translator> {
  translator ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Only the files downloaded and checked here: never a fetch of its own.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${modelsDir()}/`;
    const translate = await pipeline('translation', TRANSLATOR_REPO, { dtype: 'q8' });
    return translate as unknown as Translator;
  })().catch((error) => {
    translator = null;
    throw error;
  });
  return translator;
}

/** The ViT input: greyscale (as manga-ocr reads), resized to 224², scaled to [-1, 1]. */
async function pixelValues(image: Buffer): Promise<Float32Array> {
  const sharp = (await import('sharp')).default;
  const { data } = await sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS })
    .grayscale()
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: 'fill', kernel: 'linear' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = IMAGE_SIZE * IMAGE_SIZE;
  const pixels = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const value = data[i] / 127.5 - 1;
    pixels[i] = value;
    pixels[i + plane] = value;
    pixels[i + 2 * plane] = value;
  }
  return pixels;
}

/** manga-ocr's own clean-up: no spaces, and ASCII punctuation and digits made full-width. */
export function tidyRecognisedText(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/…/g, '...')
    .replace(/[・.]{2,}/g, (dots) => '.'.repeat(dots.length))
    .replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
}

/** The decoder's vocabulary tokens for `ids`, without the special ones. */
export function detokenise(ids: readonly number[], vocab: readonly string[]): string {
  return ids
    .map((id) => vocab[id] ?? '')
    .filter((token) => token && !/^\[[A-Z]+\]$/.test(token) && !/^<unused\d+>$/.test(token))
    .map((token) => token.replace(/^##/, ''))
    .join('');
}

async function recognise(model: MangaOcr, image: Buffer): Promise<string> {
  const { ort, encoder, decoder, vocab } = model;
  const input = new ort.Tensor('float32', await pixelValues(image), [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
  const { last_hidden_state: hidden } = await encoder.run({ pixel_values: input });
  const ids = [DECODER_START];
  for (let step = 0; step < MAX_TOKENS; step++) {
    const { logits } = await decoder.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      encoder_hidden_states: hidden,
    });
    const width = logits.dims[2];
    const scores = logits.data as Float32Array;
    const offset = (ids.length - 1) * width;
    let best = 0;
    for (let token = 1; token < width; token++) {
      if (scores[offset + token] > scores[offset + best]) best = token;
    }
    if (best === END_OF_TEXT) break;
    ids.push(best);
  }
  return tidyRecognisedText(detokenise(ids.slice(1), vocab));
}

function requireEnabled() {
  if (!localTranslationEnabled()) {
    throw new ServiceUnavailableError('Local translation is turned off on this server');
  }
}

/**
 * Waits for the models when they are already on disk; otherwise starts the download and
 * answers at once, so a request never hangs on a 200 MB download.
 */
async function requireModels(): Promise<void> {
  const state = await modelsState();
  if (state.state === 'ready') return;
  void ensureModels().catch(() => undefined);
  const percent =
    state.state === 'downloading' ? Math.floor((state.downloaded / state.total) * 100) : 0;
  const error = new ServiceUnavailableError(
    `The translation models are downloading (${percent}%). Try again when they finish.`,
  );
  error.code = 'TRANSLATION_MODELS_DOWNLOADING';
  throw error;
}

/**
 * A bubble's text as the translator reads it best: manga-ocr writes ASCII punctuation in
 * full width (！？．), which is not how the text it learned from is written.
 */
export function prepareForTranslation(text: string): string {
  return text
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\.{2,}|・{2,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FuguMT writes in lower case: sentences start with a capital, and "i" is "I". */
export function tidyTranslation(text: string): string {
  return text
    .trim()
    .replace(/\bi\b/g, 'I')
    .replace(
      /(^|[.!?…]\s+)([a-z])/g,
      (_, start: string, letter: string) => start + letter.toUpperCase(),
    );
}

/**
 * A translation that is mostly repetition, or far longer than the Japanese it came from:
 * what a sound effect or a misread scribble turns into ("ge ge e ge ge…"). Better shown as
 * the original art than as a block of noise.
 */
export function isDegenerate(source: string, translation: string): boolean {
  const words = translation.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length >= 8 && new Set(words).size / words.length < 0.5) return true;
  return translation.length > source.length * 8 + 40;
}

export function decodeImages(images: readonly string[]): Buffer[] {
  return images.map((data) => {
    const bytes = Buffer.from(data, 'base64');
    if (!detectRasterImageType(bytes)) throw new ValidationError('A bubble image was not an image');
    return bytes;
  });
}

const localTranslation = {
  async status() {
    if (!localTranslationEnabled()) return { enabled: false as const };
    return {
      enabled: true as const,
      ...(await modelsState()),
      size: TOTAL_BYTES,
      targets: ['en'] as const,
    };
  },

  /** Starts (or joins) the model download. */
  async download() {
    requireEnabled();
    void ensureModels().catch(() => undefined);
    return this.status();
  },

  /** The Japanese text in each bubble image, in the same order. */
  /**
   * The text on a whole page: found by the detector, each piece read by manga-ocr, with
   * where its translation goes as fractions of the page.
   */
  async readPage(
    image: Buffer,
  ): Promise<Array<{ text: string; x: number; y: number; w: number; h: number }>> {
    requireEnabled();
    await requireModels();
    return serially(async () => {
      const { width, height, boxes } = await detectText(image);
      if (!width || !height) return [];
      const model = await loadOcr();
      const sharp = (await import('sharp')).default;
      const page = sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
      const regions: Array<{ text: string; x: number; y: number; w: number; h: number }> = [];
      for (const { crop, place } of placeText(boxes, width, height)) {
        const cropWidth = crop.x1 - crop.x0;
        const cropHeight = crop.y1 - crop.y0;
        if (cropWidth < 4 || cropHeight < 4) continue;
        const piece = await page
          .clone()
          .extract({ left: crop.x0, top: crop.y0, width: cropWidth, height: cropHeight })
          .png()
          .toBuffer();
        const text = await recognise(model, piece);
        if (!text) continue;
        regions.push({
          text,
          x: place.x0 / width,
          y: place.y0 / height,
          w: (place.x1 - place.x0) / width,
          h: (place.y1 - place.y0) / height,
        });
      }
      return regions;
    });
  },

  async read(images: readonly Buffer[]): Promise<string[]> {
    requireEnabled();
    await requireModels();
    return serially(async () => {
      const model = await loadOcr();
      const texts: string[] = [];
      for (const image of images) texts.push(await recognise(model, image));
      return texts;
    });
  },

  /** Japanese to English, one line at a time. */
  async translate(texts: readonly string[]): Promise<string[]> {
    requireEnabled();
    await requireModels();
    return serially(async () => {
      const translate = await loadTranslator();
      const out: string[] = [];
      for (const text of texts) {
        const [result] = await translate(prepareForTranslation(text), {
          no_repeat_ngram_size: 3,
          max_new_tokens: 256,
        });
        const translation = tidyTranslation(result?.translation_text ?? '');
        // Empty is dropped by the reader, which then shows the art under it unchanged.
        out.push(isDegenerate(text, translation) ? '' : translation);
      }
      return out;
    });
  },
};

export default localTranslation;
