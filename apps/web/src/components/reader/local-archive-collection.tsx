'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { FolderOpen, FolderPlus, RefreshCw } from 'lucide-react';
import {
  localArchiveBridge,
  localArchiveError,
  type LibraryScan,
  type LocalArchive,
} from '@/lib/local-archives';
import { useCurrentUser } from '@/lib/session-resource';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';

const BUTTON =
  'inline-flex items-center gap-1.5 rounded border px-3 py-2 text-sm disabled:opacity-50';

function scanMessage({ added, removed, failed }: LibraryScan): string {
  const parts = [
    added ? `${added} added` : null,
    removed ? `${removed} gone` : null,
    failed ? `${failed} couldn't be read` : null,
  ].filter(Boolean);
  return parts.length
    ? `Library folders scanned: ${parts.join(', ')}.`
    : 'Library folders are up to date.';
}

export function LocalArchiveCollection() {
  const { user, loading: sessionLoading } = useCurrentUser();
  const [items, setItems] = useState<LocalArchive[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [remove, setRemove] = useState<LocalArchive | null>(null);
  const [desktop, setDesktop] = useState(false);
  const owner = user?.id ?? 'anonymous';
  const ownerRef = useRef(owner);
  const generation = useRef(0);
  ownerRef.current = owner;
  const [itemsOwner, setItemsOwner] = useState(owner);
  const load = useCallback(async () => {
    const bridge = localArchiveBridge();
    setDesktop(Boolean(bridge));
    if (!bridge || sessionLoading) return;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const [found, libraryFolders] = await Promise.all([
        bridge.list(),
        bridge.libraryFolders?.() ?? Promise.resolve([]),
      ]);
      if (generation.current === version && ownerRef.current === owner) {
        setItems(found);
        setFolders(libraryFolders);
        setItemsOwner(owner);
      }
    } catch {
      if (generation.current === version) setError('The local collection could not be loaded.');
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }, [sessionLoading, owner]);
  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setFolders([]);
    setRemove(null);
    setBusy(false);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [user?.id, load]);

  /** Runs one bridge call, then reloads the list. */
  const run = async <T,>(work: () => Promise<T>, onDone?: (result: T) => void) => {
    if (busy || sessionLoading) return;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await work();
      if (generation.current !== version) return;
      onDone?.(result);
      const bridge = localArchiveBridge();
      const [found, libraryFolders] = await Promise.all([
        bridge!.list(),
        bridge!.libraryFolders?.() ?? Promise.resolve([]),
      ]);
      if (generation.current === version && ownerRef.current === owner) {
        setItems(found);
        setFolders(libraryFolders);
        setItemsOwner(owner);
      }
    } catch (cause) {
      if (generation.current === version)
        setError(localArchiveError(cause, 'The local collection could not be updated.'));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  };
  const bridge = localArchiveBridge();
  const canUseFolders = Boolean(bridge?.addLibraryFolder);

  // By series (ComicInfo, or the sub-folder a library folder holds them in), the rest last.
  const groups = useMemo(() => {
    const bySeries = new Map<string, LocalArchive[]>();
    for (const item of items) {
      const key = item.series ?? '';
      bySeries.set(key, [...(bySeries.get(key) ?? []), item]);
    }
    return [...bySeries.entries()].sort(([a], [b]) => (a ? (b ? a.localeCompare(b) : -1) : 1));
  }, [items]);

  return (
    <section className="space-y-4 rounded-xl border p-4">
      <h2 className="font-semibold">Local comics</h2>
      <p className="text-sm text-muted-foreground">
        Desktop only. Import a CBZ, ZIP or EPUB comic (up to 100 MiB, 500 MiB expanded and 2,000
        pages), or a folder of JPEG, PNG or WebP pages; you can also drop one on the window.
        ComicInfo.xml fills in the series and number. Files stay on this device and are left out of
        backups and account sync.
      </p>
      {desktop ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || sessionLoading}
            onClick={() => void run(() => bridge!.import('file'))}
            className={BUTTON}
          >
            {busy ? 'Working…' : 'Import comic'}
          </button>
          <button
            type="button"
            disabled={busy || sessionLoading}
            onClick={() => void run(() => bridge!.import('folder'))}
            className={BUTTON}
          >
            <FolderOpen className="h-4 w-4" /> Import folder
          </button>
        </div>
      ) : (
        <p className="text-sm">Open the desktop app to import and read local comics.</p>
      )}

      {desktop && canUseFolders && (
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <h3 className="text-sm font-medium">Library folders</h3>
          <p className="text-xs text-muted-foreground">
            Read in place, not copied: comics in a folder, and in its sub-folders as series. Rescan
            after adding files. Removing a folder or a comic never deletes your files.
          </p>
          {folders.length > 0 && (
            <ul className="space-y-1">
              {folders.map((folder) => (
                <li key={folder} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono" title={folder}>
                    {folder}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Stop reading ${folder}`}
                    onClick={() =>
                      void run(
                        () => bridge!.removeLibraryFolder!(folder),
                        (result) => setNotice(scanMessage(result)),
                      )
                    }
                    className="rounded border px-2 py-1"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || sessionLoading}
              onClick={() =>
                void run(
                  () => bridge!.addLibraryFolder!(),
                  (result) => result && setNotice(scanMessage(result)),
                )
              }
              className={BUTTON}
            >
              <FolderPlus className="h-4 w-4" /> Add library folder
            </button>
            {folders.length > 0 && (
              <button
                type="button"
                disabled={busy || sessionLoading}
                onClick={() =>
                  void run(
                    () => bridge!.rescan!(),
                    (result) => setNotice(scanMessage(result)),
                  )
                }
                className={BUTTON}
              >
                <RefreshCw className="h-4 w-4" /> Rescan
              </button>
            )}
          </div>
        </div>
      )}

      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <button type="button" disabled={busy} onClick={load} className="ml-2 underline">
            Retry
          </button>
        </p>
      )}
      {itemsOwner === owner && !sessionLoading && items.length > 0 && (
        <div className="space-y-4">
          {groups.map(([series, group]) => (
            <div key={series || '—'} className="space-y-2">
              {(series || groups.length > 1) && (
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {series || 'Other comics'}
                </h3>
              )}
              <ul className="space-y-2">
                {group.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 rounded border p-3">
                    <Link
                      href={`/local-reader/${item.id}`}
                      className="min-w-0 flex-1 truncate text-sm underline"
                    >
                      {item.title} · {item.pageCount} pages
                    </Link>
                    {item.linked && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">In place</span>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove ${item.title}`}
                      className="rounded border px-3 py-2 text-sm"
                      onClick={() => setRemove(item)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {desktop && !busy && !error && items.length === 0 && (
        <p className="text-sm text-muted-foreground">No local comics yet.</p>
      )}
      <AlertDialog
        open={Boolean(remove) && itemsOwner === owner && !sessionLoading}
        onOpenChange={(open) => {
          if (!open && !busy) setRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Remove local comic?</AlertDialogTitle>
          <AlertDialogDescription>
            {remove?.linked
              ? `This takes ${remove.title} out of the collection. The file stays where it is; a rescan of its library folder adds it back.`
              : `This deletes the managed copy of ${remove?.title}. Your original file is kept.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async (event) => {
                event.preventDefault();
                if (!remove) return;
                const version = ++generation.current;
                setBusy(true);
                try {
                  await localArchiveBridge()?.remove(remove.id);
                  if (generation.current !== version || ownerRef.current !== owner) return;
                  setItems((previous) => previous.filter((item) => item.id !== remove.id));
                  setRemove(null);
                } catch {
                  if (generation.current === version)
                    setError('The local comic could not be removed.');
                } finally {
                  if (generation.current === version) setBusy(false);
                }
              }}
            >
              {remove?.linked ? 'Remove from collection' : 'Remove managed copy'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
