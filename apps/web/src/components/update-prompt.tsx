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
/** While nothing is happening: the desktop app keeps checking, so a release can turn up later. */
const IDLE_POLL_MS = 60_000;

/**
 * Desktop only: when the update check finds a new version, shows its changelog and asks whether
 * to update now, later (asked again next launch) or never for this version. Nothing downloads
 * until "Update now".
 *
 * Polls the desktop bridge rather than subscribing, like Settings → About: the bridge is
 * invoke-only.
 */
export function UpdatePrompt() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [updating, setUpdating] = useState(false);
  const [closedVersion, setClosedVersion] = useState<string | null>(null);

  useEffect(() => {
    const bridge = updateBridge();
    if (!bridge?.dismiss || !bridge.updateNow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await bridge.getState().catch(() => null);
      if (cancelled) return;
      const next = result?.data ?? null;
      if (next) setState(next);
      if (next && !next.supported) return;
      // A failed download comes back as the same offer, with the reason.
      if (next?.status === 'available' && next.error) setUpdating(false);
      const busy = !next || next.status === 'idle' || next.status === 'checking' || updating;
      timer = setTimeout(poll, busy ? POLL_MS : IDLE_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `updating` restarts polling so the download progress keeps moving.
  }, [updating]);

  const open =
    !!state?.prompt &&
    !!state.availableVersion &&
    state.availableVersion !== closedVersion &&
    ['available', 'downloading', 'downloaded'].includes(state.status);
  if (!state || (!open && !updating)) return null;

  const dismiss = (choice: 'later' | 'skip') => {
    setClosedVersion(state.availableVersion);
    void updateBridge()?.dismiss?.(choice);
  };
  const updateNow = () => {
    setUpdating(true);
    void updateBridge()?.updateNow?.();
  };

  return (
    <Dialog open={open || updating} onOpenChange={(next) => !next && !updating && dismiss('later')}>
      {/* Only the buttons or Escape answer it; a stray click shouldn't count as "Later". */}
      <DialogContent className="max-w-lg" onInteractOutside={(event) => event.preventDefault()}>
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

        {state.error && !updating && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}

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
