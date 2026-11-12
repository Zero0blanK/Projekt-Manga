import { MANGA_COVER_MAX_BYTES, MANGA_COVER_MIME_TYPES } from '@projekt-manga/schemas';

/** What's wrong with a picked cover image, worded for a toast; null when it can be used. */
export function coverFileProblem(file: File): string | null {
  if (!(MANGA_COVER_MIME_TYPES as readonly string[]).includes(file.type))
    return 'Choose a JPEG, PNG, GIF, WebP or AVIF image.';
  if (file.size > MANGA_COVER_MAX_BYTES) return 'That image is larger than 5 MB.';
  return null;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** A file name for a saved cover: the title, made safe for every file system. */
export function coverFileName(title: string, mimeType: string): string {
  const base = title
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  const extension = EXTENSIONS[mimeType.split(';')[0].trim()] ?? 'jpg';
  return base ? `${base} cover.${extension}` : `cover.${extension}`;
}
