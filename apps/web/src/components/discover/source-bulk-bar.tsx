'use client';
import { useState } from 'react';
import type { InstalledExtension } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { useConfirm } from '@/hooks/use-confirm';
import { extensionActions } from '@/lib/extensions-store';

const BUTTON =
  'rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50 pointer-coarse:min-h-11';

const plural = (count: number) => `${count} ${count === 1 ? 'source' : 'sources'}`;

/**
 * Acts on the sources ticked on Discover. Updating and removing apply to installed
 * extensions; a Suwayomi source has no install here, so only pinning reaches it.
 */
export function SourceBulkBar({
  ids,
  records,
  onPin,
  onClose,
}: {
  ids: string[];
  /** The installed extensions among `ids`. */
  records: InstalledExtension[];
  onPin: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  /** One failure doesn't stop the rest; the toast says how many didn't go through. */
  const forEachRecord = async (run: (record: InstalledExtension) => Promise<unknown>) => {
    setBusy(true);
    try {
      const results = await Promise.allSettled(records.map(run));
      return results.filter((result) => result.status === 'rejected').length;
    } finally {
      setBusy(false);
    }
  };

  const update = async () => {
    let changed = 0;
    const failed = await forEachRecord(async (record) => {
      if (await extensionActions.checkForUpdate(record.id)) changed += 1;
    });
    toast({
      description: failed
        ? `${plural(failed)} couldn't be checked. ${changed} updated.`
        : changed
          ? `${plural(changed)} updated.`
          : 'Everything selected is up to date.',
    });
  };

  const remove = async () => {
    const removing = await confirm({
      title: `Remove ${plural(records.length)}?`,
      description:
        'Titles from these sources stay in your library, but can’t update or open new chapters until the source is installed again.',
      confirmLabel: 'Remove',
    });
    if (!removing) return;
    const failed = await forEachRecord((record) => extensionActions.uninstall(record.id));
    toast({
      description: failed
        ? `${plural(failed)} couldn't be removed.`
        : `${plural(records.length)} removed.`,
    });
    if (!failed) onClose();
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Selected sources"
        className="fixed inset-x-4 bottom-6 z-40 mx-auto flex max-w-xl flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-popover/95 px-4 py-3 shadow-xl backdrop-blur"
      >
        <span role="status" className="min-w-0 flex-1 text-sm font-semibold">
          {busy ? 'Working…' : `${ids.length} selected`}
        </span>
        <button type="button" className={BUTTON} disabled={busy || !ids.length} onClick={onPin}>
          Pin
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !records.length}
          onClick={() => void update()}
        >
          Update
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !records.length}
          onClick={() => void remove()}
        >
          Remove
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onClose}>
          Done
        </button>
      </div>
      {dialog}
    </>
  );
}
