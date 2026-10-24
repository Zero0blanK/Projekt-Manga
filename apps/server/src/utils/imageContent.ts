export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const rasterTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];

export function detectRasterImageType(bytes: Buffer): string | null {
  return rasterTypes.find((type) => matchesImageSignature(bytes, type)) ?? null;
}

export function matchesImageSignature(bytes: Buffer, type: string): boolean {
  switch (type) {
    case 'image/jpeg':
      return bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'image/png':
      return (
        bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      );
    case 'image/gif':
      return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP'
      );
    case 'image/avif':
      return (
        bytes.length >= 16 &&
        bytes.toString('ascii', 4, 8) === 'ftyp' &&
        /avif|avis/.test(bytes.toString('ascii', 8, Math.min(bytes.length, 32)))
      );
    default:
      return false;
  }
}
