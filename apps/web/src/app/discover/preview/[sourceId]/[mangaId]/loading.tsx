import { SourcePreviewShell } from '@/components/discover/source-preview-shell';

/** Shown while the preview page's own server-side fetch (getSourceMangaDetails, a live
 * scrape) is in flight — this can take noticeably longer than a database read. Opened from
 * a source card, it already shows that card's title and cover; the rest streams in. */
export default function Loading() {
  return <SourcePreviewShell />;
}
