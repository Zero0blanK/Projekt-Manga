import { ReaderSkeleton } from '@/components/skeletons';

/** Shown while the source-preview reader's own server-side fetch (getSourceMangaDetails,
 * a live scrape) is in flight. */
export default function Loading() {
  return <ReaderSkeleton />;
}
