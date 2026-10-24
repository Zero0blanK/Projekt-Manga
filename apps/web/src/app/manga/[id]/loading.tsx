import { MangaDetailHeaderSkeleton } from '@/components/skeletons';

/** Shown while the manga/[id] page's own server-side fetch (getMangaDetailsById) is in
 * flight — this route has no client-side loading state to fall back on since the whole
 * detail header renders from data the server component awaits before responding. */
export default function Loading() {
  return <MangaDetailHeaderSkeleton />;
}
