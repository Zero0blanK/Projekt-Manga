import { MangaDetailHeaderSkeleton } from '@/components/skeletons';

/** Shown while the preview page's own server-side fetch (getSourceMangaDetails, a live
 * scrape) is in flight — this can take noticeably longer than a database read. */
export default function Loading() {
  return <MangaDetailHeaderSkeleton />;
}
