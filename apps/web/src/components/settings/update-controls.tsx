'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Field, Group, ToggleSwitch } from '@/components/settings/field-controls';
import { toast } from '@/hooks/use-toast';
import {
  updateBridge,
  type Envelope,
  type UpdateBridge,
  type UpdateState,
} from '@/lib/desktop-update';

/**
 * Settings → About's update controls.
 *
 * Renders nothing at all outside the desktop app: `apps/web` has to keep working in a plain
 * browser, where there is no shell to update and `window.desktop` is `undefined`.
 *
 * State is **polled** rather than pushed. The desktop bridge is invoke/handle only (see
 * DESKTOP_CHANNELS in apps/desktop/src/shared/config.ts); the one fast-changing value is the
 * download percentage, and it only matters while this panel is on screen — which is exactly when
 * the poll is running. The interval is cleared on unmount, so nothing ticks in the background.
 */

const POLL_MS = 2000;

function statusLine(state: UpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Version ${state.availableVersion} is available.`;
    case 'downloading':
      return state.downloadPercent === null
        ? 'Downloading…'
        : `Downloading… ${state.downloadPercent}%`;
    case 'downloaded':
      return `Version ${state.availableVersion} is ready to install.`;
    case 'up-to-date':
      return 'Up to date.';
    case 'error':
      return state.error ?? 'The update check failed.';
    default:
      return `Version ${state.currentVersion}.`;
  }
}

export function UpdateControls() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  // Resolved in an effect so the server render and first client render agree.
  const bridgeRef = useRef<UpdateBridge | null>(null);

  const refresh = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    try {
      const result = await bridge.getState();
      if (result.data) setState(result.data);
    } catch {
      // A failed poll is not worth surfacing: the next tick will either succeed or the panel
      // will be gone. The real failure is already reported through `state.error`.
    }
  }, []);

  useEffect(() => {
    bridgeRef.current = updateBridge();
    if (!bridgeRef.current) return;

    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Not the desktop app, or a build with no update feed — nothing to offer.
  if (!state || !state.supported) return null;

  const run = async (action: () => Promise<Envelope<unknown>>) => {
    setBusy(true);
    try {
      const result = await action();
      if (!result.success) throw new Error(result.message ?? 'Update action failed');
      await refresh();
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : 'Update action failed. Try again.',
      });
    } finally {
      setBusy(false);
    }
  };

  const bridge = bridgeRef.current;
  const checking = state.status === 'checking' || state.status === 'downloading';

  return (
    <>
      <Group label="Updates" />

      <Field label="Status" hint={statusLine(state)}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => bridge && void run(() => bridge.check())}
            disabled={busy || checking}
            className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface/60 disabled:opacity-60"
          >
            {busy || checking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Check for updates
          </button>

          {/* Only reachable with auto-download off — otherwise it is already downloading. */}
          {state.status === 'available' && (
            <button
              type="button"
              onClick={() => bridge && void run(() => bridge.download())}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface/60 disabled:opacity-60"
            >
              <Download className="h-3.5 w-3.5" />
              Download now
            </button>
          )}

          {state.status === 'downloaded' && (
            <button
              type="button"
              onClick={() => bridge && void run(() => bridge.installNow())}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Restart to install
            </button>
          )}
        </div>
      </Field>

      <Field
        label="Download automatically"
        nested
        hint="Off means you choose when to download. Updates still install when you quit."
      >
        <ToggleSwitch
          on={state.autoDownload}
          disabled={busy}
          label="Download updates automatically"
          onToggle={() => bridge && void run(() => bridge.setAutoDownload(!state.autoDownload))}
        />
      </Field>
    </>
  );
}
