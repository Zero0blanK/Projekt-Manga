import { downloadedChapterCbzUrl } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import type { DownloadRow } from '@/components/downloads/row-data';

/** The server's name for the file (Content-Disposition), or a fallback. */
function fileNameFrom(header: string | null, fallback: string): string {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* fall through to the plain name */
    }
  }
  return header?.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
}

/**
 * Saves a downloaded chapter as a CBZ. Fetched rather than linked to: the API can sit on
 * another origin, where the desktop window would hand a plain link to the OS browser and
 * the browser would ignore the `download` attribute. The desktop app shows its save dialog
 * for the blob as for any download.
 */
export async function exportChapterCbz(row: Pick<DownloadRow, 'chapterId' | 'title' | 'chapters'>) {
  try {
    const response = await fetch(downloadedChapterCbzUrl(row.chapterId), {
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileNameFrom(
      response.headers.get('Content-Disposition'),
      `${row.title} - ${row.chapters}.cbz`,
    );
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  } catch {
    toast({ variant: 'destructive', description: `Couldn't export ${row.chapters} as a CBZ.` });
  }
}
