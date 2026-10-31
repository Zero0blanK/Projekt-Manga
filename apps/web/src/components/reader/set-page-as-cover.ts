import { uploadMangaCover } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { queryClient, queryKeys } from '@/lib/query-client';

/**
 * The reader's "Set as cover": the page's own image becomes the title's custom cover,
 * through the same upload as Edit title (the server checks type and size). The library
 * is refreshed so the new cover shows there.
 */
export async function setPageAsCover(mangaId: string, imageUrl: string) {
  try {
    const response = await fetch(imageUrl, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await uploadMangaCover(mangaId, await response.blob());
    void queryClient.invalidateQueries({ queryKey: queryKeys.mangaLibrary });
    toast({ description: 'Cover updated.' });
  } catch (error) {
    toast({
      variant: 'destructive',
      description:
        error instanceof Error && error.message && !error.message.startsWith('HTTP')
          ? `Couldn't set the cover: ${error.message}`
          : "Couldn't set this page as the cover.",
    });
  }
}
