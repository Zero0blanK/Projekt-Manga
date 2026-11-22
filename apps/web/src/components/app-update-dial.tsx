'use client';

import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { ProgressDial } from '@/components/progress-dial';
import { useAppUpdateProgress } from '@/lib/app-update-progress';
import { updateBridge } from '@/lib/desktop-update';

/**
 * The desktop update the reader asked for, in the bottom-right corner with the library
 * update and download dials: its download progress, then "Restart to update" once it is
 * ready. Restart now installs it and reopens the app; Later leaves it to install when the
 * app next quits.
 */
export function AppUpdateDial() {
  const progress = useAppUpdateProgress();
  const [later, setLater] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  if (!progress) return null;
  const { version, percent, ready } = progress;

  if (!ready) {
    return (
      <ProgressDial
        id="app-update"
        name="app update"
        fraction={(percent ?? 0) / 100}
        status={`Downloading version ${version}${percent !== null ? `: ${percent}%` : '…'}`}
      />
    );
  }
  if (later === version) return null;

  return (
    <div
      role="status"
      className="pointer-events-auto w-72 max-w-full rounded-2xl border border-border/60 bg-popover/95 p-3 shadow-xl shadow-black/30 backdrop-blur"
    >
      <p className="text-sm font-medium text-foreground">Version {version} is ready</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {restarting
          ? 'Installing. Projekt Manga will close and reopen by itself…'
          : 'Restart to update now, or it installs when you next quit Projekt Manga.'}
      </p>
      {!restarting && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setLater(version)}
            className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => {
              setRestarting(true);
              void updateBridge()?.installNow();
            }}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Restart to update
          </button>
        </div>
      )}
    </div>
  );
}
