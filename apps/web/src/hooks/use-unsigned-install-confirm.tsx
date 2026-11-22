'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { actions, getSetting } from '@/lib/app-store';

/**
 * Settings › Extensions › "Warn before installing from unsigned repositories". On unless
 * the reader ticked "Don't ask again" on the warning, or turned it off there.
 */
export const WARN_UNSIGNED_REPOSITORIES = 'warnUnsignedRepositories';

/**
 * The warning before installing a source from a repository that doesn't sign its sources.
 * `confirmUnsigned` resolves true to install anyway; with the warning turned off it
 * resolves true at once, without asking. Render `dialog` once in the component tree.
 */
export function useUnsignedInstallConfirm(): {
  confirmUnsigned: () => Promise<boolean>;
  dialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(false);
  }, []);

  const confirmUnsigned = useCallback(() => {
    if (getSetting(WARN_UNSIGNED_REPOSITORIES, true) === false) return Promise.resolve(true);
    resolver.current?.(false);
    setDontAsk(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen(true);
    });
  }, []);

  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    [],
  );

  const dialog = (
    <AlertDialog open={open} onOpenChange={(next) => !next && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Install from an unsigned repository?</AlertDialogTitle>
          <AlertDialogDescription>
            This repository does not sign its sources, so nothing verifies who wrote this code. Only
            install it if you trust the repository.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(event) => setDontAsk(event.target.checked)}
            className="size-4 accent-primary"
          />
          Don&apos;t ask again
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              // Only "Install anyway" saves it: ticking the box and cancelling changes nothing.
              if (dontAsk) actions.setSetting(WARN_UNSIGNED_REPOSITORIES, false);
              settle(true);
            }}
          >
            Install anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirmUnsigned, dialog };
}
