import { Transform } from 'node:stream';
import { PayloadTooLargeError } from './customErrors.js';

/**
 * Passes a byte stream through unchanged until its cumulative size exceeds `maxBytes`.
 *
 * Content-Length is optional and untrusted, so proxy callers need this second limit while
 * data is actually flowing; otherwise a chunked response can consume unlimited bandwidth
 * despite the pre-flight header check.
 */
export function createByteLimitStream(maxBytes: number, message: string): Transform {
  let totalBytes = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (totalBytes > maxBytes) {
        callback(new PayloadTooLargeError(message));
        return;
      }
      callback(null, chunk);
    },
  });
}
