import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { MangaCover } from '@/components/manga-card';
import type { Manga } from '@/lib/manga-data';

/** Cover art that opens a larger view when clicked. */
export function MangaCoverDialog({ manga }: { manga: Manga }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className="block w-full max-w-[220px] cursor-zoom-in text-left transition hover:opacity-90"
          aria-label={`View cover for ${manga.title}`}
        >
          <MangaCover manga={manga} chapterBadge={false} statusBadge={false} />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-xs border-none bg-transparent p-0 shadow-none">
        <DialogTitle className="sr-only">{manga.title} cover</DialogTitle>
        <MangaCover manga={manga} chapterBadge={false} statusBadge={false} />
      </DialogContent>
    </Dialog>
  );
}
