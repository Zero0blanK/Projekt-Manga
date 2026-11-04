import fs from 'node:fs/promises';

/**
 * Library covers at the size they are shown, for `GET /cache/thumbnail/:id?w=400`.
 *
 * Only the stored covers: resizing a cover still on its way from a source would mean the
 * server downloading it first, and the reader's progress ring would have nothing to show.
 * Each width is made once and kept beside the original, so the orphan sweep removes it
 * with its cover.
 *
 * `sharp` is an optional dependency with a native binary. If it can't load, or a file
 * won't decode, the caller sends the original: a larger cover beats a missing one.
 */

export const THUMBNAIL_WIDTHS = [200, 400, 800] as const;

type Sharp = typeof import('sharp');
let sharp: Promise<Sharp | null> | undefined;

function loadSharp(): Promise<Sharp | null> {
  sharp ??= import('sharp').then(
    (module) => module.default as unknown as Sharp,
    () => {
      console.warn('[thumbnails] Image resizing is unavailable; serving original covers');
      return null;
    },
  );
  return sharp;
}

/** The requested width if it is one of ours; anything else means the original. */
export function thumbnailWidth(raw: unknown): number | null {
  const width = Number(raw);
  return (THUMBNAIL_WIDTHS as readonly number[]).includes(width) ? width : null;
}

/** The file to send for `file` at `width`: a resized copy, or `file` itself. */
export async function resizedThumbnail(file: string, width: number): Promise<string> {
  const resized = `${file}.w${width}.webp`;
  try {
    const [original, existing] = await Promise.all([
      fs.stat(file),
      fs.stat(resized).catch(() => null),
    ]);
    if (existing && existing.mtimeMs >= original.mtimeMs) return resized;
    const library = await loadSharp();
    if (!library) return file;
    // Written beside it and renamed, so a reader never gets half a file.
    const partial = `${resized}.${process.pid}.tmp`;
    await (library as unknown as (input: string) => import('sharp').Sharp)(file)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(partial);
    await fs.rename(partial, resized);
    return resized;
  } catch (error) {
    console.warn(
      `[thumbnails] Could not resize a cover: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return file;
  }
}
