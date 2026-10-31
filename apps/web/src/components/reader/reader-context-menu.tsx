'use client';

import { useState, type ReactNode } from 'react';
import { Copy, Download, Expand, ImageUp, Keyboard, Languages, Share2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { usePageImageActions } from '@/components/reader/page-image-actions';
import { openReaderShortcuts, toggleFullscreen } from '@/components/reader/reader-shortcuts';
import { useAlwaysOnTop } from '@/lib/desktop-window';
import { useSetting } from '@/lib/app-store';
import { toast } from '@/hooks/use-toast';
import {
  READER_TRANSLATE_TARGET,
  pageTranslation,
  showOriginal,
  translatePage,
  translateTargetFor,
  translationAvailable,
  usePageTranslation,
} from '@/lib/page-translation';

/**
 * Right-click on the reader: the page under the cursor (either page of a spread) can be
 * saved, copied or shared, plus fullscreen and the shortcut sheet. Elsewhere in the
 * reader (its header, panels) the browser's own menu is left alone.
 */
export function ReaderContextMenu({
  children,
  pageUrls,
  page,
  mangaTitle,
  chapter,
  onSetCover,
}: {
  children: ReactNode;
  pageUrls: readonly string[];
  /** The page shown, used when the click lands between pages. */
  page: number;
  mangaTitle: string;
  chapter?: number;
  /** Offered when the title can take a custom cover (one in the library). */
  onSetCover?: (imageUrl: string) => void;
}) {
  // The page under the cursor, by its own image URL: the long strip also shows pages of
  // the chapters around this one, which `pageUrls` doesn't cover.
  const [target, setTarget] = useState<{ page: number; url?: string }>({ page });
  const imageUrl = target.url ?? (pageUrls[target.page - 1] || undefined);
  const alwaysOnTop = useAlwaysOnTop();
  const actions = usePageImageActions({ imageUrl, mangaTitle, chapter, page: target.page });
  const translation = usePageTranslation(imageUrl);
  const targetLanguage = useSetting(READER_TRANSLATE_TARGET, 'English') as string;
  const translate = async () => {
    if (!imageUrl) return;
    if (!(await translationAvailable())) {
      toast({
        variant: 'destructive',
        description: "Translation isn't set up on this server (see TRANSLATE_PROVIDER).",
      });
      return;
    }
    await translatePage(imageUrl, translateTargetFor(targetLanguage));
    const result = pageTranslation(imageUrl);
    if (result?.status === 'error') toast({ variant: 'destructive', description: result.message });
  };
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          className="contents"
          onContextMenu={(event) => {
            const clicked = (event.target as Element).closest<HTMLElement>('[data-page]');
            const number = Number(clicked?.dataset.page);
            setTarget(
              Number.isInteger(number) && number > 0
                ? {
                    page: number,
                    // The page's own URL, not an enhanced copy's blob: URL.
                    url:
                      clicked?.dataset.imageUrl ??
                      clicked?.querySelector('img')?.getAttribute('src') ??
                      undefined,
                  }
                : { page },
            );
          }}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={!imageUrl} onSelect={() => void actions.save()}>
          <Download className="mr-2 h-4 w-4" /> Save page {target.page}
        </ContextMenuItem>
        <ContextMenuItem disabled={!imageUrl} onSelect={() => void actions.copy()}>
          <Copy className="mr-2 h-4 w-4" /> Copy image
        </ContextMenuItem>
        {actions.canShare && (
          <ContextMenuItem disabled={!imageUrl} onSelect={() => void actions.share()}>
            <Share2 className="mr-2 h-4 w-4" /> Share
          </ContextMenuItem>
        )}
        {onSetCover && (
          <ContextMenuItem disabled={!imageUrl} onSelect={() => imageUrl && onSetCover(imageUrl)}>
            <ImageUp className="mr-2 h-4 w-4" /> Set as cover
          </ContextMenuItem>
        )}
        {translation?.status === 'done' && translation.shown ? (
          <ContextMenuItem onSelect={() => imageUrl && showOriginal(imageUrl)}>
            <Languages className="mr-2 h-4 w-4" /> Show original
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            disabled={!imageUrl || translation?.status === 'working'}
            onSelect={() => void translate()}
          >
            <Languages className="mr-2 h-4 w-4" />
            {translation?.status === 'working'
              ? 'Translating…'
              : translation?.status === 'done'
                ? 'Show translation'
                : 'Translate page'}
          </ContextMenuItem>
        )}
        {translation?.status === 'error' && (
          <p role="status" className="px-2 pb-1 text-xs text-muted-foreground">
            {translation.message}
          </p>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={toggleFullscreen}>
          <Expand className="mr-2 h-4 w-4" /> Fullscreen
        </ContextMenuItem>
        {alwaysOnTop.available && (
          <ContextMenuCheckboxItem checked={alwaysOnTop.onTop} onSelect={alwaysOnTop.toggle}>
            Keep window on top
          </ContextMenuCheckboxItem>
        )}
        <ContextMenuItem onSelect={openReaderShortcuts}>
          <Keyboard className="mr-2 h-4 w-4" /> Keyboard shortcuts
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
