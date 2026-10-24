'use client';

import { useEffect, useState } from 'react';
import { Field, Group, ToggleSwitch } from '@/components/settings/field-controls';
import { toast } from '@/hooks/use-toast';

interface StartupState {
  supported: boolean;
  enabled: boolean;
}

interface Envelope {
  success: boolean;
  message?: string;
  data?: StartupState;
}

interface StartupBridge {
  getState: () => Promise<Envelope>;
  setEnabled: (enabled: boolean) => Promise<Envelope>;
}

function startupBridge(): StartupBridge | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as { desktop?: { startupBackground?: StartupBridge } }).desktop
      ?.startupBackground ?? null
  );
}

export function StartupBackgroundControl() {
  const [bridge, setBridge] = useState<StartupBridge | null>(null);
  const [state, setState] = useState<StartupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const desktop = startupBridge();
    if (!desktop) return;
    let active = true;
    setBridge(desktop);
    desktop
      .getState()
      .then((result) => {
        if (!result.success || !result.data) throw new Error(result.message ?? 'Unavailable');
        if (active) setState(result.data);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!bridge || (!state && !loadFailed) || (state && !state.supported)) return null;

  const toggle = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const result = await bridge.setEnabled(!state.enabled);
      if (!result.success || !result.data)
        throw new Error(result.message ?? 'Could not save setting');
      setState(result.data);
    } catch {
      toast({
        variant: 'destructive',
        description: 'Could not change startup behavior. Try again.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group label="Desktop startup" />
      <Field
        label="Run in background at sign-in"
        hint="Start the desktop app when you sign in, without opening a window. Use the system tray to open or quit it."
      >
        {state ? (
          <ToggleSwitch
            on={state.enabled}
            disabled={busy}
            label="Run Projekt Manga in background at sign-in"
            onToggle={() => void toggle()}
          />
        ) : (
          <span role="status" className="text-xs text-destructive">
            Startup setting unavailable. Relaunch the app to retry.
          </span>
        )}
      </Field>
    </>
  );
}
