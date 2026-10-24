import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { createByteLimitStream } from '../../src/utils/byteLimitStream.js';

describe('createByteLimitStream', () => {
  it('rejects a response once its cumulative byte count exceeds the ceiling', async () => {
    await expect(
      pipeline(
        Readable.from([Buffer.alloc(8), Buffer.alloc(3)]),
        createByteLimitStream(10, 'Image response is too large'),
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 413, message: 'Image response is too large' });
  });
});
