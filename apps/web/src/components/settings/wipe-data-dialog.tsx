'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/hooks/use-toast';
import { queryClient, queryKeys } from '@/lib/query-client';
import { clearAllBrowseSnapshots } from '@/lib/browse-state';
import { clearStaticDataCache } from '@/lib/startup-static-data';
import {
  getWipeInventory,
  wipeSelectedData,
  type WipeInventory,
  type WipeSelection,
} from '@/lib/wipe-data';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

const EMPTY_SELECTION: WipeSelection = {
  library: false,
  history: false,
  downloads: false,
};
const ALL_SELECTION: WipeSelection = {
  library: true,
  history: true,
  downloads: true,
};

const OPTIONS: { key: keyof WipeSelection; label: string; detail: string }[] = [
  {
    key: 'library',
    label: 'Library membership',
    detail:
      'Remove titles from your library, not their shared catalog rows, chapters, or reading progress.',
  },
  {
    key: 'history',
    label: 'Reading history',
    detail:
      'Delete history for this account or the anonymous server profile, plus visible desktop-local history.',
  },
  {
    key: 'downloads',
    label: 'Downloaded chapters',
    detail:
      'Delete every downloaded chapter on this server, including files shared with other accounts.',
  },
];

export function WipeDataDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<WipeSelection>(EMPTY_SELECTION);
  const [wipeAll, setWipeAll] = useState(false);
  const [counts, setCounts] = useState<WipeInventory | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = wipeAll || Object.values(selection).some(Boolean);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void getWipeInventory().then(
      (inventory) => {
        if (active) setCounts(inventory);
      },
      () => {
        if (active) setCounts(null);
      },
    );
    return () => {
      active = false;
    };
  }, [open]);

  const resetForm = () => {
    setSelection(EMPTY_SELECTION);
    setWipeAll(false);
    setCounts(null);
    setConfirmation('');
  };

  const changeOpen = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) resetForm();
  };

  const wipe = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (busy || !selected || confirmation !== 'WIPE') return;
    setBusy(true);
    const selectedData = wipeAll ? ALL_SELECTION : selection;
    setOpen(false);
    resetForm();
    void wipeSelectedData(selectedData)
      .then((result) => {
        const failures = Object.values(result).reduce(
          (total, count) => total + count.failed + Number(count.readFailed),
          0,
        );
        if (failures === 0 && selectedData.library) {
          queryClient.setQueryData(queryKeys.mangaLibrary, []);
          queryClient.setQueryData(queryKeys.libraryState, []);
        }
        toast({ description: failures === 0 ? 'Wipe finished.' : 'Wipe request finished.' });
      })
      .catch(() => {
        toast({ description: 'Wipe could not finish. Some data may have been removed.' });
      })
      .finally(() => {
        if (wipeAll) {
          clearStaticDataCache();
          clearAllBrowseSnapshots();
        }
        void queryClient.invalidateQueries();
        router.refresh();
        setBusy(false);
      });
  };

  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogTrigger asChild>
        <button
          disabled={busy}
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50"
        >
          {busy ? 'Wiping…' : 'Choose data to wipe…'}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Choose what to wipe</AlertDialogTitle>
          <AlertDialogDescription>
            Nothing is selected by default. Export a backup first if you may need this data again;
            downloaded image files are not included in that export. Your account, saved chapter
            progress, installed sources, and shared manga catalog are not removed by this dialog. If
            you are signed out, library and history belong to the shared anonymous profile on this
            server.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="space-y-3">
          <legend className="sr-only">Data to wipe</legend>
          <label className="flex cursor-pointer gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <input
              type="checkbox"
              checked={wipeAll}
              disabled={busy}
              onChange={(event) => {
                setWipeAll(event.target.checked);
              }}
              className="mt-0.5 size-4 accent-destructive"
            />
            <span>
              <span className="block font-medium text-foreground">Wipe all listed data</span>
              <span className="block text-xs text-muted-foreground">
                Includes all three choices below; disables individual choices. Does not reset
                preferences or delete your account, progress, sources, or catalog.
              </span>
            </span>
          </label>
          {OPTIONS.map(({ key, label, detail }) => (
            <label
              key={key}
              className="flex cursor-pointer gap-3 rounded-lg border border-border/60 p-3 text-sm"
            >
              <input
                type="checkbox"
                checked={wipeAll || selection[key]}
                disabled={busy || wipeAll}
                onChange={(event) => {
                  setSelection((current) => ({ ...current, [key]: event.target.checked }));
                }}
                className="mt-0.5 size-4 accent-destructive"
              />
              <span>
                <span className="block font-medium text-foreground">
                  {label} ({counts ? (counts[key] ?? 'unavailable') : 'loading…'})
                </span>
                <span className="block text-xs text-muted-foreground">{detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="block text-xs text-muted-foreground">
          Type <strong>WIPE</strong> to confirm the selected items
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
            autoComplete="off"
            className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={wipe}
            disabled={busy || !selected || confirmation !== 'WIPE'}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? 'Wiping…' : 'Wipe selected data'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
