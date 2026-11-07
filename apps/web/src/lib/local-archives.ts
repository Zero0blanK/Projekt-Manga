'use client';

import { desktopBridge } from '@/lib/desktop-bridge';

export type LocalArchive = {
  id: string;
  title: string;
  importedAt: string;
  pageCount: number;
  /** From ComicInfo.xml, or the sub-folder of a library folder it was found in. */
  series?: string;
  writer?: string;
  /** Read in place from a library folder rather than copied into the app. */
  linked?: boolean;
};
export type LibraryScan = { added: number; removed: number; failed: number };
export type LocalArchiveBridge = {
  list: () => Promise<LocalArchive[]>;
  /** Copies a comic in: an archive (CBZ, ZIP, EPUB) or a folder of pages. */
  import: (kind?: 'file' | 'folder') => Promise<LocalArchive | null>;
  /** The next comic opened from outside the app (Open with, a drop on the window). */
  openPending?: () => Promise<LocalArchive | null>;
  /** Imports a file or folder dropped on the window. */
  importDropped?: (file: File) => Promise<LocalArchive>;
  libraryFolders?: () => Promise<string[]>;
  addLibraryFolder?: () => Promise<({ folders: string[] } & LibraryScan) | null>;
  removeLibraryFolder?: (folder: string) => Promise<{ folders: string[] } & LibraryScan>;
  rescan?: () => Promise<LibraryScan>;
  page: (id: string, index: number) => Promise<{ bytes: Uint8Array; mime: string }>;
  remove: (id: string) => Promise<boolean>;
};
export function localArchiveBridge(): LocalArchiveBridge | undefined {
  if (typeof window === 'undefined') return;
  return desktopBridge<{ archives: LocalArchiveBridge }>()?.archives;
}

/** Strips Electron's "Error invoking remote method" wrapper from a main-process error. */
export function localArchiveError(cause: unknown, fallback: string): string {
  return cause instanceof Error
    ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : fallback;
}
