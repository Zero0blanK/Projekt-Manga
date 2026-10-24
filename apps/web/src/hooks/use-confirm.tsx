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

export type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
};

export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

/**
 * Promise-based replacement for `window.confirm`. Render `dialog` once in the component
 * tree and `await confirm(...)`; it resolves true only when the action button is chosen
 * (cancel, Escape and an outside click all resolve false).
 */
export function useConfirm(): { confirm: Confirm; dialog: ReactNode } {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  }, []);

  const confirm = useCallback<Confirm>((options) => {
    // A second request while one is open supersedes it rather than leaving it pending.
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setRequest(options);
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
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {request?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => settle(true)}>
            {request?.confirmLabel ?? 'Confirm'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
