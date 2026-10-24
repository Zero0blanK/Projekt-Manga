'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { localArchiveBridge, type LocalArchive } from '@/lib/local-archives';
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

export function LocalArchiveCollection() {
  const { user, loading: sessionLoading } = useCurrentUser();
  const [items, setItems] = useState<LocalArchive[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      const found = await bridge.list();
      if (generation.current === version && ownerRef.current === owner) {
        setItems(found);
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
    setRemove(null);
    setBusy(false);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [user?.id, load]);
  const importArchive = async () => {
    const bridge = localArchiveBridge();
    if (!bridge || busy || sessionLoading) return;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const imported = await bridge.import();
      if (generation.current !== version) return;
      if (imported) {
        const found = await bridge.list();
        if (generation.current === version && ownerRef.current === owner) {
          setItems(found);
          setItemsOwner(owner);
        }
      }
    } catch (cause) {
      if (generation.current === version)
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
            : 'The CBZ could not be imported.',
        );
    } finally {
      if (generation.current === version) setBusy(false);
    }
  };
  return (
    <section className="space-y-4 rounded-xl border p-4">
      <h2 className="font-semibold">Local CBZ collection</h2>
      <p className="text-sm text-muted-foreground">
        Desktop only. Import JPEG, PNG or WebP comic pages from a CBZ up to 100 MiB, 500 MiB
        expanded and 2,000 pages. Each page may be up to 32 MiB, 16 megapixels and 16,384 pixels per
        dimension. Files remain on this device and are excluded from backups and account sync.
      </p>
      {desktop ? (
        <button
          type="button"
          disabled={busy || sessionLoading}
          onClick={importArchive}
          className="rounded border px-3 py-2 text-sm disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Import CBZ'}
        </button>
      ) : (
        <p className="text-sm">Open the desktop app to import and read local CBZ files.</p>
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
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 rounded border p-3">
              <Link
                href={`/local-reader/${item.id}`}
                className="min-w-0 flex-1 truncate text-sm underline"
              >
                {item.title} · {item.pageCount} pages
              </Link>
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
      )}
      {desktop && !busy && !error && items.length === 0 && (
        <p className="text-sm text-muted-foreground">No local comics imported yet.</p>
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
            This deletes the managed copy of {remove?.title}. Your original CBZ is kept.
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
              Remove managed copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
