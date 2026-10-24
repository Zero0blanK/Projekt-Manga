import { ReaderSkeleton } from '@/components/skeletons';

/** Shown while the reader page's own server-side fetch (getMangaDetailsById) is in
 * flight, before ReaderPageClient has any chapter/manga data to render from. */
export default function Loading() {
  return <ReaderSkeleton />;
}
