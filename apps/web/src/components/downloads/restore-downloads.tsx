'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  restoreDownloads,
  scanForDownloadsToRestore,
  setDownloadDirectory,
  type DownloadRestoreScan,
  type RestorableTitle,
} from '@projekt-manga/api-client';
import { FolderSearch, History, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { desktopBridge } from '@/lib/desktop-bridge';
import { refreshLibrary, setTitleInLibrary } from '@/lib/library-store';
import { isAborted, reportError } from '@/lib/report-error';

/**
 * Brings back downloads the app has no record of.
 *
 * After a reinstall whose app data is gone, on a new computer, or with downloads kept in a
 * folder this install never used, the chapter folders are still on disk but the Downloads
 * page is empty. This looks through the folders the app knows when the page opens and
 * offers what it finds; "Find downloads in another folder" points it anywhere else.
 * Restoring only records the folders found; nothing on disk is moved or changed.
 */

interface PickFolderBridge {
  pickFolder: (title?: string) => Promise<{ success: boolean; data: string | null }>;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** What a title's row says about it, beyond the chapters that come back. */
function titleNote(title: RestorableTitle): string | null {
  const source = title.sourceName ?? title.source;
  switch (title.status) {
    case 'needs-source':
      return `Install the ${source} source to restore this title.`;
    case 'not-found':
      return `Not found on ${source}, so its chapters can't be matched.`;
    case 'lookup-failed':
      return `${source} didn't answer. Try again later.`;
    case 'nothing-to-restore':
      return 'Nothing new to restore.';
    default: {
      const notes = [
        title.chapters.incomplete > 0 &&
          `${plural(title.chapters.incomplete, 'incomplete chapter')} skipped`,
        title.chapters.alreadyInApp > 0 &&
          `${plural(title.chapters.alreadyInApp, 'chapter')} already downloaded`,
        title.chapters.unmatched > 0 &&
          `${plural(title.chapters.unmatched, 'chapter')} not found on ${source}`,
      ].filter(Boolean);
      return notes.length > 0 ? notes.join(' · ') : null;
    }
  }
}

export function RestoreDownloads({ onRestored }: { onRestored: () => void }) {
  const pickFolder = desktopBridge<PickFolderBridge>()?.pickFolder;
  /** The folders the app knows, scanned when the page opens. */
  const [known, setKnown] = useState<DownloadRestoreScan | null>(null);
  /** A folder the user pointed at, and what it holds. */
  const [chosen, setChosen] = useState<{ root: string; scan: DownloadRestoreScan } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typedPath, setTypedPath] = useState('');
  const [addToLibrary, setAddToLibrary] = useState<Set<string>>(new Set());
  const [saveAsDownloadFolder, setSaveAsDownloadFolder] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const scanKnown = useCallback((signal?: AbortSignal) => {
    return scanForDownloadsToRestore(undefined, signal)
      .then(setKnown)
      .catch((error) => {
        // Quiet: the page works without it, and the scan runs again next time.
        if (!isAborted(error)) setKnown(null);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void scanKnown(controller.signal);
    return () => controller.abort();
  }, [scanKnown]);

  const showing = chosen?.scan ?? known;
  const listed = (showing?.titles ?? []).filter((title) => title.status !== 'nothing-to-restore');
  const ready = listed.filter((title) => title.status === 'ready');
  /** Copies of titles the app already has: not listed, but worth saying they were seen. */
  const alreadyHere = (showing?.titles ?? []).filter(
    (title) => title.status === 'nothing-to-restore' && title.chapters.alreadyInApp > 0,
  ).length;

  const openReview = (scan: DownloadRestoreScan) => {
    setAddToLibrary(new Set());
    setSaveAsDownloadFolder(false);
    setOpen(scan.titles.some((title) => title.status !== 'nothing-to-restore'));
  };

  const scanFolder = async (root: string) => {
    setScanning(true);
    try {
      const scan = await scanForDownloadsToRestore(root);
      setChosen({ root, scan });
      setTyping(false);
      if (scan.titles.some((title) => title.status !== 'nothing-to-restore')) {
        openReview(scan);
      } else {
        toast({ description: 'No downloads to restore were found in that folder.' });
      }
    } catch (error) {
      reportError(error, "Couldn't look through that folder.");
    } finally {
      setScanning(false);
    }
  };

  const findElsewhere = async () => {
    if (!pickFolder) {
      setTyping(true);
      return;
    }
    try {
      const picked = await pickFolder('Choose the folder that holds your downloads');
      if (picked?.data) await scanFolder(picked.data);
    } catch (error) {
      reportError(error, "Couldn't open the folder picker.");
    }
  };

  const restore = async () => {
    if (ready.length === 0) return;
    setRestoring(true);
    const root = chosen?.root;
    try {
      const result = await restoreDownloads(
        ready.map((title) => title.id),
        root,
      );
      const toAdd = result.titles.filter((title) => addToLibrary.has(title.id));
      const failedToAdd: string[] = [];
      for (const title of toAdd) {
        try {
          await setTitleInLibrary(title.mangaId, true, { refresh: false });
        } catch {
          failedToAdd.push(title.title);
        }
      }
      if (toAdd.length > 0) await refreshLibrary();
      if (root && saveAsDownloadFolder) await setDownloadDirectory(root);

      const chapters = result.restored + result.relinked;
      toast({
        description:
          chapters > 0
            ? `Restored ${plural(chapters, 'chapter')} from ${plural(result.titles.length, 'title')}.`
            : 'Those downloads were already restored.',
      });
      if (failedToAdd.length > 0) {
        toast({ description: `Couldn't add ${failedToAdd.join(', ')} to the library.` });
      }
      setOpen(false);
      setChosen(null);
      onRestored();
      await scanKnown();
    } catch (error) {
      reportError(error, "Couldn't restore those downloads.");
    } finally {
      setRestoring(false);
    }
  };

  const knownListed = (known?.titles ?? []).filter(
    (title) => title.status !== 'nothing-to-restore',
  );
  const knownReady = knownListed.filter((title) => title.status === 'ready').length;

  return (
    <>
      {knownListed.length > 0 && (
        <section
          aria-labelledby="restore-downloads-heading"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4"
        >
          <div className="flex min-w-0 items-start gap-3">
            <History className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <h3 id="restore-downloads-heading" className="text-sm font-medium text-foreground">
                {knownReady > 0
                  ? `Found ${plural(knownReady, 'downloaded title')} (${plural(known!.restorableChapters, 'chapter')}) to restore`
                  : `Found ${plural(knownListed.length, 'downloaded title')} that can't be restored yet`}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                They're on disk from an earlier install, but not on this page. Restoring adds them
                back without moving any files.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => known && (setChosen(null), openReview(known))}>
            Review and restore
          </Button>
        </section>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={scanning}
          onClick={() => void findElsewhere()}
        >
          {scanning ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <FolderSearch className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          )}
          Find downloads in another folder
        </Button>
        {typing && (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (typedPath.trim()) void scanFolder(typedPath.trim());
            }}
          >
            <Input
              aria-label="Folder with your downloads"
              placeholder="D:\Manga\ProjektManga"
              value={typedPath}
              onChange={(event) => setTypedPath(event.target.value)}
              className="h-8 min-w-0 flex-1 text-xs sm:max-w-sm"
            />
            <Button size="sm" type="submit" disabled={scanning || !typedPath.trim()}>
              Look
            </Button>
          </form>
        )}
      </div>

      <Dialog open={open} onOpenChange={(next) => !restoring && setOpen(next)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Restore downloads</DialogTitle>
            <DialogDescription>
              {ready.length > 0
                ? `${plural(ready.length, 'title')} and ${plural(showing?.restorableChapters ?? 0, 'chapter')} will be added back to Downloads.`
                : 'None of these can be restored yet.'}{' '}
              Found in {showing?.roots.join(', ')}.
              {alreadyHere > 0 &&
                ` ${plural(alreadyHere, 'other title')} found there ${alreadyHere === 1 ? 'is' : 'are'} already in Downloads.`}
            </DialogDescription>
          </DialogHeader>

          {ready.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>Tick the titles to add to your library as well.</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAddToLibrary(new Set(ready.map((title) => title.id)))}
                >
                  Add all to library
                </Button>
                {addToLibrary.size > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setAddToLibrary(new Set())}>
                    Clear
                  </Button>
                )}
              </div>
            </div>
          )}

          <ul
            className="-mx-1 max-h-[45vh] space-y-1 overflow-y-auto px-1"
            aria-label="Titles found"
          >
            {listed.map((title) => {
              const note = titleNote(title);
              const restorable = title.status === 'ready';
              const checkboxId = `restore-library-${title.id}`;
              return (
                <li
                  key={title.id}
                  className="flex items-start gap-3 rounded-lg border border-border/60 p-3"
                >
                  {restorable ? (
                    <Checkbox
                      id={checkboxId}
                      className="mt-0.5"
                      aria-label={`Add ${title.title} to library`}
                      checked={addToLibrary.has(title.id)}
                      onCheckedChange={(checked) =>
                        setAddToLibrary((current) => {
                          const next = new Set(current);
                          if (checked === true) next.add(title.id);
                          else next.delete(title.id);
                          return next;
                        })
                      }
                    />
                  ) : (
                    <span className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor={restorable ? checkboxId : undefined}
                      className="block truncate text-sm font-medium text-foreground"
                    >
                      {title.title}
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {title.sourceName ?? title.source}
                      {restorable &&
                        ` · ${plural(title.chapters.ready, 'chapter')} · ${formatBytes(title.sizeBytes)}`}
                    </p>
                    {note && (
                      <p
                        className={
                          restorable ? 'text-xs text-muted-foreground' : 'text-xs text-amber-600'
                        }
                      >
                        {note}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {chosen && ready.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={saveAsDownloadFolder}
                onCheckedChange={(checked) => setSaveAsDownloadFolder(checked === true)}
              />
              Save new downloads to this folder too
            </label>
          )}

          <DialogFooter>
            <Button variant="ghost" disabled={restoring} onClick={() => setOpen(false)}>
              Close
            </Button>
            {ready.length > 0 && (
              <Button disabled={restoring} onClick={() => void restore()}>
                {restoring && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {restoring
                  ? 'Restoring…'
                  : `Restore ${plural(showing?.restorableChapters ?? 0, 'chapter')}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
