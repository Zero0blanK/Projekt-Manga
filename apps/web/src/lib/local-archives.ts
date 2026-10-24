'use client';

export type LocalArchive = { id: string; title: string; importedAt: string; pageCount: number };
export type LocalArchiveBridge = {
  list: () => Promise<LocalArchive[]>;
  import: () => Promise<LocalArchive | null>;
  page: (id: string, index: number) => Promise<{ bytes: Uint8Array; mime: string }>;
  remove: (id: string) => Promise<boolean>;
};
export function localArchiveBridge(): LocalArchiveBridge | undefined {
  if (typeof window === 'undefined') return;
  return (window as unknown as { desktop?: { archives?: LocalArchiveBridge } }).desktop?.archives;
}
