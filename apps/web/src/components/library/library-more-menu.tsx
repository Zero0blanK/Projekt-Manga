'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRightLeft,
  Bookmark,
  CalendarDays,
  FolderOpen,
  MoreHorizontal,
  Shuffle,
  Sparkles,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Manga } from '@/lib/manga-data';

/**
 * The library's other places, gathered in one menu. They used to sit as icons among the
 * controls that sort and filter the list, where they read as more of those controls.
 */
export function LibraryMoreMenu({ library }: { library: Manga[] }) {
  const router = useRouter();
  const hasTitles = library.length > 0;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="More library pages"
        title="More"
        className="grid h-9 w-9 place-items-center rounded-lg border border-border/60 text-muted-foreground transition hover:text-foreground"
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem asChild>
          <Link href="/bookmarks">
            <Bookmark /> Bookmarks
          </Link>
        </DropdownMenuItem>
        {hasTitles && (
          <DropdownMenuItem asChild>
            <Link href="/upcoming">
              <CalendarDays /> Upcoming releases
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href="/year">
            <Sparkles /> Year in manga
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/local">
            <FolderOpen /> Local comics
          </Link>
        </DropdownMenuItem>
        {hasTitles && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/migrate">
                <ArrowRightLeft /> Migrate a source
              </Link>
            </DropdownMenuItem>
          </>
        )}
        {library.length > 1 && (
          <DropdownMenuItem
            onSelect={() =>
              router.push(
                `/manga/${encodeURIComponent(library[Math.floor(Math.random() * library.length)].id)}`,
              )
            }
          >
            <Shuffle /> Random title
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
