import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import localTranslation, {
  detokenise,
  tidyRecognisedText,
} from '../src/services/localTranslation.service.js';
import {
  MODEL_FILES,
  ensureModels,
  modelsState,
  resetModelsState,
} from '../src/services/translationModels.service.js';
import { resetTranslateState } from '../src/services/translate.service.js';

// A 1×1 PNG: an image as far as the signature check goes. The models themselves are faked.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
).toString('base64');

let modelsDir = '';

beforeEach(async () => {
  process.env.LOCAL_TRANSLATION = 'on';
  modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-models-'));
  process.env.TRANSLATION_MODELS_DIR = modelsDir;
  resetModelsState();
  resetTranslateState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TRANSLATION_MODELS_DIR;
  await fs.rm(modelsDir, { recursive: true, force: true });
});

describe("manga-ocr's output", () => {
  it('is tidied as manga-ocr does: no spaces, ASCII made full-width', () => {
    expect(tidyRecognisedText('ちょっと 待って!')).toBe('ちょっと待って！');
    expect(tidyRecognisedText('え…?')).toBe('え．．．？');
  });

  it('leaves out the special tokens', () => {
    const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '<unused0>', '猫', 'で', 'す'];
    expect(detokenise([5, 6, 4, 7, 0], vocab)).toBe('猫です');
  });
});

describe('local translation', () => {
  it('reads bubbles and translates them to English on this server', async () => {
    const read = vi.spyOn(localTranslation, 'read').mockResolvedValue(['猫です']);
    const translate = vi.spyOn(localTranslation, 'translate').mockResolvedValue(['A cat']);

    const status = await request(app).get('/api/translate/status');
    expect(status.body.data).toMatchObject({ enabled: true, provider: 'local', origin: 'local' });

    const texts = await request(app)
      .post('/api/translate/read')
      .send({ images: [PNG] });
    expect(texts.status).toBe(200);
    expect(texts.body.data).toEqual({ texts: ['猫です'] });
    expect(read).toHaveBeenCalledTimes(1);

    const english = await request(app)
      .post('/api/translate')
      .send({ texts: ['猫です'], target: 'en' });
    expect(english.body.data).toEqual({ translations: ['A cat'] });
    expect(translate).toHaveBeenCalledWith(['猫です']);
  });

  it('is English only, and says where other languages come from', async () => {
    const res = await request(app)
      .post('/api/translate')
      .send({ texts: ['猫です'], target: 'es' });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/English only/);
  });

  it('refuses anything that is not an image', async () => {
    const res = await request(app)
      .post('/api/translate/read')
      .send({ images: [Buffer.from('not an image').toString('base64')] });
    expect(res.status).toBe(400);
  });

  it('answers at once while the models are missing, and starts downloading them', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app)
      .post('/api/translate/read')
      .send({ images: [PNG] });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/downloading/);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/${MODEL_FILES[0].repo}/resolve/${MODEL_FILES[0].revision}/`),
        expect.anything(),
      ),
    );
    expect((await modelsState()).state).toBe('downloading');
  });

  it('keeps no file that does not match its checksum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('tampered', { status: 200 })),
    );
    await expect(ensureModels()).rejects.toThrow(/checksum/);
    expect(await modelsState()).toEqual({
      state: 'error',
      message: "A downloaded model file didn't match its checksum",
    });
    const left = await fs.readdir(modelsDir, { recursive: true });
    expect(left.filter((entry) => String(entry).endsWith('.onnx'))).toEqual([]);
  });

  it('can be turned off by the host', async () => {
    process.env.LOCAL_TRANSLATION = 'off';
    expect((await request(app).get('/api/translate/local')).body.data).toEqual({
      enabled: false,
    });
    const res = await request(app)
      .post('/api/translate/read')
      .send({ images: [PNG] });
    expect(res.status).toBe(503);
  });
});
