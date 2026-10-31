'use client';

import { Copy, Download, ImageIcon, Share2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/hooks/use-toast';
import { pageImageFileName } from '@/lib/page-image';

/** The page image as a file. Fetched from the same URL the reader shows, with
 * credentials, so a downloaded or account-only page comes back the same way. */
async function fetchPage(url: string, fileName: string): Promise<File> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const extension = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  return new File([blob], `${fileName}.${extension}`, { type: blob.type || 'image/jpeg' });
}

/** Browsers only accept PNG on the clipboard, so other formats are redrawn as PNG. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('encode'))), 'image/png'),
  );
}

const failed = (description: string) => toast({ variant: 'destructive', description });

export type PageImageTarget = {
  imageUrl?: string;
  mangaTitle: string;
  /** Absent for a local comic, which has no chapters. */
  chapter?: number;
  page: number;
};

/** Save, copy and share for one page image, shared by the toolbar menu and the reader's
 * right-click menu. */
export function usePageImageActions({ imageUrl, mangaTitle, chapter, page }: PageImageTarget) {
  const fileName = pageImageFileName(mangaTitle, chapter, page);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const save = async () => {
    if (!imageUrl) return;
    try {
      const file = await fetchPage(imageUrl, fileName);
      const href = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = file.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      failed("Couldn't save this page.");
    }
  };

  const copy = async () => {
    if (!imageUrl) return;
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      failed('Copying images needs a secure connection (https, or localhost).');
      return;
    }
    try {
      const png = await asPng(await fetchPage(imageUrl, fileName));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast({ description: `Page ${page} copied` });
    } catch {
      failed("Couldn't copy this page — your browser blocked it.");
    }
  };

  const share = async () => {
    if (!imageUrl) return;
    try {
      const file = await fetchPage(imageUrl, fileName);
      if (!navigator.canShare?.({ files: [file] })) {
        failed("This browser can't share images.");
        return;
      }
      await navigator.share({
        files: [file],
        title: chapter === undefined ? mangaTitle : `${mangaTitle} · Chapter ${chapter}`,
      });
    } catch (error) {
      // Closing the share sheet rejects with AbortError; that isn't a failure.
      if ((error as Error)?.name !== 'AbortError') failed("Couldn't share this page.");
    }
  };

  return { save, copy, share, canShare };
}

/** Save, copy or share the page being read. */
export function PageImageActions(target: PageImageTarget) {
  const { imageUrl, page } = target;
  const { save, copy, share, canShare } = usePageImageActions(target);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Page image"
        disabled={!imageUrl}
        className="grid h-9 w-9 place-items-center rounded-lg text-white/70 transition hover:bg-white/5 hover:text-white disabled:opacity-30"
      >
        <ImageIcon className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void save()}>
          <Download className="mr-2 h-4 w-4" /> Save page {page}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copy()}>
          <Copy className="mr-2 h-4 w-4" /> Copy image
        </DropdownMenuItem>
        {canShare && (
          <DropdownMenuItem onSelect={() => void share()}>
            <Share2 className="mr-2 h-4 w-4" /> Share
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
