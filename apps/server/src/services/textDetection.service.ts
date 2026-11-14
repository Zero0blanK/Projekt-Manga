import { MODEL_FILES, TEXT_DETECTOR_REPO, localPath } from './translationModels.service.js';

/**
 * Finding the text on a manga page with a model trained for it (RT-DETR-v2 fine-tuned on
 * about 11k manga, webtoon, manhua and western comic pages), instead of rules about white
 * areas and glyph-sized marks. It finds three things: speech bubbles, the text inside them,
 * and text set outside any bubble (narration, signs, asides), whatever the bubble's shape,
 * colour or border, and whether or not it touches the panel edge.
 *
 * The text boxes are what manga-ocr reads (tight around the words, as it reads best); the
 * bubble around a text box is where the translation goes, so it uses the bubble's room.
 */

/** The model's input: the page resized (not cropped) to 640², scaled to [0, 1]. */
const INPUT_SIZE = 640;
const MAX_IMAGE_PIXELS = 8192 * 8192;
/** Detections less sure than this are left out. */
export const MIN_SCORE = 0.35;

export type BoxLabel = 'bubble' | 'text_bubble' | 'text_free';
const LABELS: readonly BoxLabel[] = ['bubble', 'text_bubble', 'text_free'];

/** A detection, in the page's pixels. */
export interface DetectedBox {
  label: BoxLabel;
  score: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Rect = Pick<DetectedBox, 'x0' | 'y0' | 'x1' | 'y1'>;

/** Where a piece of text is read from, and where its translation goes, in page pixels. */
export interface TextPlacement {
  crop: Rect;
  place: Rect;
}

type Ort = typeof import('onnxruntime-node');
type Session = import('onnxruntime-node').InferenceSession;

let detector: Promise<{ ort: Ort; session: Session }> | null = null;

function loadDetector() {
  detector ??= (async () => {
    const ort = (await import('onnxruntime-node')) as unknown as Ort;
    const file = MODEL_FILES.find((entry) => entry.repo === TEXT_DETECTOR_REPO)!;
    const session = await ort.InferenceSession.create(localPath(file), {
      graphOptimizationLevel: 'all',
    });
    return { ort, session };
  })().catch((error) => {
    detector = null;
    throw error;
  });
  return detector;
}

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

function overlap(a: Rect, b: Rect): number {
  return area({
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  });
}

/**
 * Turns the detections into what to read and where to put it:
 *
 * - one reading per piece of text: a text box mostly inside a larger one is dropped;
 * - text in a bubble is placed over the bubble's inner area (an ellipse's inner rectangle),
 *   never smaller than the text itself, so a short translation still gets the room;
 * - text outside any bubble is placed over itself, a little wider.
 *
 * Pure, so it is tested without the model.
 */
export function placeText(
  boxes: readonly DetectedBox[],
  width: number,
  height: number,
): TextPlacement[] {
  const sure = boxes.filter((box) => box.score >= MIN_SCORE);
  const bubbles = sure.filter((box) => box.label === 'bubble');
  const texts = sure
    .filter((box) => box.label !== 'bubble')
    .sort((a, b) => area(b) - area(a))
    .filter((box, index, all) =>
      all.slice(0, index).every((larger) => overlap(box, larger) / Math.max(1, area(box)) <= 0.5),
    );

  const clamp = (r: Rect): Rect => ({
    x0: Math.max(0, Math.floor(r.x0)),
    y0: Math.max(0, Math.floor(r.y0)),
    x1: Math.min(width, Math.ceil(r.x1)),
    y1: Math.min(height, Math.ceil(r.y1)),
  });

  const holds = (bubble: Rect, text: Rect) =>
    overlap(text, bubble) / Math.max(1, area(text)) >= 0.6;
  return texts.map((text) => {
    // The smallest bubble holding most of this text, when it is the only text there: a
    // "bubble" holding several (a burst, a flash behind a whole panel) gives each its own
    // spot, or one translation would cover the others.
    const bubble = bubbles
      .filter((candidate) => holds(candidate, text))
      .sort((a, b) => area(a) - area(b))
      .find((candidate) => texts.filter((other) => holds(candidate, other)).length === 1);
    const pad = Math.max(4, Math.min(text.x1 - text.x0, text.y1 - text.y0) * 0.08);
    const crop = clamp({
      x0: text.x0 - pad,
      y0: text.y0 - pad,
      x1: text.x1 + pad,
      y1: text.y1 + pad,
    });
    let place: Rect;
    if (bubble) {
      const insetX = (bubble.x1 - bubble.x0) * 0.13;
      const insetY = (bubble.y1 - bubble.y0) * 0.13;
      place = {
        x0: Math.min(bubble.x0 + insetX, text.x0),
        y0: Math.min(bubble.y0 + insetY, text.y0),
        x1: Math.max(bubble.x1 - insetX, text.x1),
        y1: Math.max(bubble.y1 - insetY, text.y1),
      };
    } else {
      const grow = (text.x1 - text.x0) * 0.15;
      place = { x0: text.x0 - grow, y0: text.y0, x1: text.x1 + grow, y1: text.y1 };
    }
    return { crop, place: clamp(place) };
  });
}

/** The page's text and bubbles, in its own pixels. */
export async function detectText(
  image: Buffer,
): Promise<{ width: number; height: number; boxes: DetectedBox[] }> {
  const sharp = (await import('sharp')).default;
  const source = sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
  const { width = 0, height = 0 } = await source.metadata();
  if (!width || !height) return { width: 0, height: 0, boxes: [] };
  const { data } = await source
    .clone()
    .removeAlpha()
    .toColourspace('srgb')
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill', kernel: 'linear' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = INPUT_SIZE * INPUT_SIZE;
  const pixels = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    pixels[i] = data[i * 3] / 255;
    pixels[i + plane] = data[i * 3 + 1] / 255;
    pixels[i + 2 * plane] = data[i * 3 + 2] / 255;
  }

  const { ort, session } = await loadDetector();
  const output = await session.run({
    images: new ort.Tensor('float32', pixels, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    // Boxes come back in the page's own pixels: width first.
    orig_target_sizes: new ort.Tensor(
      'int64',
      BigInt64Array.from([BigInt(width), BigInt(height)]),
      [1, 2],
    ),
  });
  const labels = output.labels.data as BigInt64Array | Int32Array;
  const scores = output.scores.data as Float32Array;
  const coords = output.boxes.data as Float32Array;
  const boxes: DetectedBox[] = [];
  for (let i = 0; i < scores.length; i++) {
    const label = LABELS[Number(labels[i])];
    if (!label || scores[i] < MIN_SCORE) continue;
    boxes.push({
      label,
      score: scores[i],
      x0: coords[i * 4],
      y0: coords[i * 4 + 1],
      x1: coords[i * 4 + 2],
      y1: coords[i * 4 + 3],
    });
  }
  return { width, height, boxes };
}
