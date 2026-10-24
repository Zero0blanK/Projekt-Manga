'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { updateBridge, type UpdateState } from '@/lib/desktop-update';

const POLL_MS = 2000;
/** The launch check runs in the background; stop waiting for it after this long. */
const GIVE_UP_AFTER_MS = 3 * 60 * 1000;

/**
 * Desktop only: when the launch update check finds a new version, shows its changelog and asks
 * whether to update now, later (asked again next launch) or never for this version.
 *
 * Polls the desktop bridge rather than subscribing, like Settings → About: the bridge is
 * invoke-only. Polling stops once the check settles with nothing to offer, or after a few
 * minutes, so nothing ticks in the background for the rest of the session.
 */
export function UpdatePrompt() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [updating, setUpdating] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const bridge = updateBridge();
    if (!bridge?.dismiss || !bridge.updateNow) return;
    const started = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await bridge.getState().catch(() => null);
      if (cancelled) return;
      const next = result?.data ?? null;
      if (next) setState(next);
      const settledWithNothing =
        next &&
        (!next.supported ||
          next.status === 'up-to-date' ||
          next.status === 'error' ||
          (next.availableVersion && !next.prompt && !updating));
      if (settledWithNothing || Date.now() - started > GIVE_UP_AFTER_MS) return;
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `updating` restarts polling so the download progress keeps moving.
  }, [updating]);

  const open =
    !closed &&
    !!state?.prompt &&
    !!state.availableVersion &&
    ['available', 'downloading', 'downloaded'].includes(state.status);
  if (!state || (!open && !updating)) return null;

  const dismiss = (choice: 'later' | 'skip') => {
    setClosed(true);
    void updateBridge()?.dismiss?.(choice);
  };
  const updateNow = () => {
    setUpdating(true);
    void updateBridge()?.updateNow?.();
  };

  return (
    <Dialog open={open || updating} onOpenChange={(next) => !next && !updating && dismiss('later')}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Version {state.availableVersion} is available</DialogTitle>
          <DialogDescription>
            You have version {state.currentVersion}. Here&apos;s what changed:
          </DialogDescription>
        </DialogHeader>

        <div
          className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-surface/40 p-3 text-sm leading-relaxed text-foreground/90"
          tabIndex={0}
          aria-label="Changelog"
        >
          {state.releaseNotes ?? 'No release notes were published for this version.'}
        </div>

        {updating ? (
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {state.status === 'downloaded'
              ? 'Restarting to install…'
              : `Downloading${state.downloadPercent !== null ? ` ${state.downloadPercent}%` : ''}…`}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => dismiss('skip')}
              className="mr-auto rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              Skip this version
            </button>
            <button
              type="button"
              onClick={() => dismiss('later')}
              className="rounded-lg border border-border/60 px-4 py-2 text-xs font-medium text-foreground transition hover:bg-accent"
            >
              Later
            </button>
            <button
              type="button"
              onClick={updateNow}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
            >
              <Download className="h-3.5 w-3.5" />
              Update now
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
